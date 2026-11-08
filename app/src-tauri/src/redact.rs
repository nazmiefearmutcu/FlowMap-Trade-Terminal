//! Keeps session tokens out of the sidecar log.
//!
//! The sidecar's stdout and stderr are written to `flowmap-server.log`. Uvicorn
//! logs every WebSocket handshake with its query string, and the client connects
//! with `?token=<session token>`, so the raw output would carry the token. The
//! shell redacts it on the way into the file. Redaction works on whole lines, so
//! a token split across two pipe reads is still caught.

use std::fs;
use std::io::{self, ErrorKind, Write};
use std::path::Path;

/// What is written in place of a secret.
const MASK: &[u8] = b"***";
/// Longest partial line held back while waiting for its newline.
const MAX_PENDING: usize = 64 * 1024;
/// Bytes kept back when a long line is written in pieces, so a token that
/// straddles the cut is whole when the next piece arrives. A session token is 64
/// hex characters, so this leaves room for it.
const TAIL_KEPT: usize = 256;
/// Bytes that end a query-string value.
const VALUE_END: &[u8] = b"&\"' \t\r\n)]}>,;";
/// The query-string key whose value is always masked.
const TOKEN_KEY: &[u8] = b"token=";

/// Replace every known secret, and every `token=<value>` query value, in `bytes`.
pub(crate) fn redact(bytes: &[u8], secrets: &[&str]) -> Vec<u8> {
    let mut text = bytes.to_vec();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        text = replace_all(&text, secret.as_bytes(), MASK);
    }
    mask_token_params(&text)
}

fn replace_all(haystack: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    while i < haystack.len() {
        if haystack[i..].starts_with(needle) {
            out.extend_from_slice(with);
            i += needle.len();
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    out
}

/// Mask the value of every `token=` parameter, whatever the secret was. This
/// covers logs written before the session token was known to the shell.
fn mask_token_params(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let is_key = bytes[i..].len() >= TOKEN_KEY.len()
            && bytes[i..i + TOKEN_KEY.len()].eq_ignore_ascii_case(TOKEN_KEY);
        if !is_key {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        out.extend_from_slice(&bytes[i..i + TOKEN_KEY.len()]);
        i += TOKEN_KEY.len();
        let end = bytes[i..]
            .iter()
            .position(|byte| VALUE_END.contains(byte))
            .map_or(bytes.len(), |offset| i + offset);
        if end > i {
            out.extend_from_slice(MASK);
        }
        i = end;
    }
    out
}

/// A byte sink that redacts what passes through it before the inner writer sees
/// it. Output is released a whole line at a time, so a secret split across writes
/// is redacted in full.
pub(crate) struct RedactingSink<W: Write> {
    inner: W,
    secrets: Vec<String>,
    pending: Vec<u8>,
}

impl<W: Write> RedactingSink<W> {
    pub(crate) fn new(inner: W, secrets: Vec<String>) -> Self {
        Self {
            inner,
            secrets,
            pending: Vec::new(),
        }
    }

    /// Write out the held-back tail at end of stream, then flush.
    pub(crate) fn finish(&mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            self.emit(&rest)?;
        }
        self.inner.flush()
    }

    fn emit(&mut self, bytes: &[u8]) -> io::Result<()> {
        let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
        self.inner.write_all(&redact(bytes, &secrets))
    }
}

impl<W: Write> Write for RedactingSink<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        let ready = match self.pending.iter().rposition(|&byte| byte == b'\n') {
            Some(last_newline) => last_newline + 1,
            None if self.pending.len() > MAX_PENDING => release_point(&self.pending),
            None => 0,
        };
        if ready > 0 {
            let chunk: Vec<u8> = self.pending.drain(..ready).collect();
            self.emit(&chunk)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// How much of an over-long line without a newline may be released now. The cut
/// goes just after the last delimiter that is at least `TAIL_KEPT` bytes from the
/// end, so a token (a run of bytes with no delimiter) is never split between the
/// released head and the kept tail. Only a line with no delimiter in its head is
/// cut at the plain offset.
fn release_point(pending: &[u8]) -> usize {
    let limit = pending.len() - TAIL_KEPT;
    pending[..limit]
        .iter()
        .rposition(|byte| VALUE_END.contains(byte))
        .map_or(limit, |index| index + 1)
}

/// Rewrite a log that an earlier build wrote, which may hold tokens from before
/// redaction existed. Only the query-string rule applies: those tokens are dead.
pub(crate) fn scrub_file(path: &Path) -> io::Result<()> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    let clean = redact(&bytes, &[]);
    if clean != bytes {
        fs::write(path, clean)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "3f9a0c1d2e4b5a6978869504a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4";

    #[test]
    fn a_known_session_token_is_masked_wherever_it_appears() {
        let line = format!("GET /ws?token={TOKEN} HTTP/1.1 accepted {TOKEN}\n");
        let out = redact(line.as_bytes(), &[TOKEN]);
        let text = String::from_utf8(out).unwrap();
        assert!(!text.contains(TOKEN), "{text}");
        assert_eq!(text, "GET /ws?token=*** HTTP/1.1 accepted ***\n");
    }

    #[test]
    fn a_token_parameter_is_masked_even_when_its_secret_is_not_known() {
        let out = redact(b"accepted /ws?token=abc123&room=1 end", &[]);
        assert_eq!(out, b"accepted /ws?token=***&room=1 end");
    }

    #[test]
    fn lines_without_a_token_pass_through_unchanged() {
        let line = b"INFO:     127.0.0.1:5000 - \"GET /api/health HTTP/1.1\" 200 OK\n";
        assert_eq!(redact(line, &[TOKEN]), line.to_vec());
    }

    #[test]
    fn a_token_split_across_writes_is_still_masked() {
        let mut sink = RedactingSink::new(Vec::new(), vec![TOKEN.to_string()]);
        sink.write_all(b"GET /ws?tok").unwrap();
        sink.write_all(format!("en={TOKEN} HTTP/1.1\n").as_bytes())
            .unwrap();
        sink.finish().unwrap();
        let text = String::from_utf8(sink.inner.clone()).unwrap();
        assert!(!text.contains(TOKEN), "{text}");
        assert_eq!(text, "GET /ws?token=*** HTTP/1.1\n");
    }

    #[test]
    fn an_unterminated_tail_is_released_only_by_finish() {
        let mut sink = RedactingSink::new(Vec::new(), vec![TOKEN.to_string()]);
        sink.write_all(format!("last words {TOKEN}").as_bytes())
            .unwrap();
        assert!(
            sink.inner.is_empty(),
            "a partial line waits for its newline"
        );
        sink.finish().unwrap();
        assert_eq!(sink.inner, b"last words ***");
    }

    #[test]
    fn a_long_line_without_a_newline_never_releases_a_whole_token() {
        let mut sink = RedactingSink::new(Vec::new(), vec![TOKEN.to_string()]);
        sink.write_all(&vec![b'x'; MAX_PENDING]).unwrap();
        // Crosses the limit with the token in the middle of the tail.
        sink.write_all(format!("{TOKEN} tail").as_bytes()).unwrap();
        sink.finish().unwrap();
        let text = String::from_utf8(sink.inner.clone()).unwrap();
        assert!(!text.contains(TOKEN));
        assert!(text.ends_with("*** tail"), "{}", &text[text.len() - 20..]);
    }

    #[test]
    fn a_token_that_straddles_the_release_point_is_never_released_in_part() {
        let mut sink = RedactingSink::new(Vec::new(), vec![TOKEN.to_string()]);
        // A space ends the filler, so the token starts a delimiter-free run. The
        // plain cut (buffer length minus TAIL_KEPT) would land 32 bytes into it.
        let mut filler = vec![b'x'; MAX_PENDING - 101];
        filler.push(b' ');
        sink.write_all(&filler).unwrap();
        let mut rest = TOKEN.as_bytes().to_vec();
        rest.extend(std::iter::repeat_n(b'z', 224));
        sink.write_all(&rest).unwrap();
        sink.finish().unwrap();
        let text = String::from_utf8(sink.inner.clone()).unwrap();
        assert!(
            !text.contains(&TOKEN[..16]),
            "a prefix of the token was released"
        );
        let expected = format!("{} ***{}", "x".repeat(MAX_PENDING - 101), "z".repeat(224));
        assert_eq!(text, expected);
    }

    #[test]
    fn scrubbing_an_old_log_removes_its_tokens_once() {
        let dir = std::env::temp_dir().join(format!("flowmap-scrub-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.previous.log");
        fs::write(&path, format!("INFO accepted /ws?token={TOKEN}\n")).unwrap();
        scrub_file(&path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "INFO accepted /ws?token=***\n");
        scrub_file(&path).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), text);
        // A missing file is nothing to scrub.
        scrub_file(&dir.join("absent.log")).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
