//! The sidecar's output log: capped, rotated once, and redacted on the way in.
//!
//! `flowmap-server.log` keeps the sidecar's stdout and stderr. The first spawn of
//! a run moves the previous run's log aside, so a crash traceback survives the
//! relaunch. A respawn appends behind a dated separator, so a crash loop keeps
//! every traceback.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::redact::{self, RedactingSink};
use crate::{now_secs, shell_log, utc_timestamp};

/// The server log is moved aside to `*.previous.log` at this size.
const SERVER_LOG_MAX_BYTES: u64 = 20 * 1024 * 1024;

/// `<name>.previous.log` next to `<name>.log`.
fn previous_log_path(path: &Path) -> PathBuf {
    path.with_extension("previous.log")
}

/// Move `path` aside to its `.previous.log` name, replacing any older copy. With no
/// current log there is nothing to move, and the older copy is kept as it is.
pub(crate) fn rotate_to_previous(path: &Path) {
    if !path.is_file() {
        return;
    }
    let previous = previous_log_path(path);
    let _ = fs::remove_file(&previous);
    if let Err(err) = fs::rename(path, &previous) {
        // Without the move the log keeps growing past its cap, so say so.
        shell_log(&format!("could not move {} aside: {err}", path.display()));
    }
}

/// Open `path` for appending; returns the file and its current length.
fn open_append(path: &Path) -> io::Result<(File, u64)> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let len = file.metadata()?.len();
    Ok((file, len))
}

/// Append-only sink for sidecar output, capped at `max_bytes`: when a write
/// would pass the cap, the full file moves to `<name>.previous.log` and writing
/// continues in a fresh file. A crash traceback therefore survives one rotation.
pub(crate) struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    written: u64,
    max_bytes: u64,
}

impl RotatingLog {
    fn open(path: &Path, max_bytes: u64) -> io::Result<Self> {
        let (file, written) = open_append(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            written,
            max_bytes,
        })
    }

    fn rotate(&mut self) {
        // Close before renaming: Windows refuses to rename an open file.
        self.file = None;
        rotate_to_previous(&self.path);
        self.written = 0;
    }
}

impl Write for RotatingLog {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written > 0 && self.written + buf.len() as u64 > self.max_bytes {
            self.rotate();
        }
        let file = match &mut self.file {
            Some(file) => file,
            slot => {
                let (file, len) = open_append(&self.path)?;
                self.written = len;
                slot.insert(file)
            }
        };
        file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.file {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

/// Open the sidecar log for spawn number `spawn_index` (0 = the initial
/// spawn of this app run, >=1 = a supervisor respawn).
///
/// The FIRST spawn of a run moves the previous run's log aside to
/// `flowmap-server.previous.log`, so the crash traceback that made the user
/// relaunch survives the relaunch. Every RESPAWN appends and writes a dated
/// `--- respawn #N ---` separator first, so a crash loop keeps every traceback.
pub(crate) fn open_sidecar_log(path: &Path, spawn_index: u32) -> io::Result<RotatingLog> {
    if spawn_index == 0 {
        rotate_to_previous(path);
        // The moved-aside log may come from a build that wrote tokens unredacted.
        // A failure here must not stop the app, so it is only logged.
        if let Err(err) = redact::scrub_file(&previous_log_path(path)) {
            shell_log(&format!("could not scrub the previous server log: {err}"));
        }
    }
    let mut log = RotatingLog::open(path, SERVER_LOG_MAX_BYTES)?;
    if spawn_index > 0 {
        writeln!(
            log,
            "\n--- respawn #{spawn_index} --- {} ---",
            utc_timestamp(now_secs())
        )?;
    }
    Ok(log)
}

/// Copy a child's output into the shared, redacting log until the pipe closes.
/// Write errors are ignored on purpose: the pipe must keep draining, or the
/// sidecar would block on a full pipe.
pub(crate) fn pump_output<R: Read + Send + 'static>(
    mut source: R,
    sink: Arc<Mutex<RedactingSink<RotatingLog>>>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match source.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut log) = sink.lock() {
                        let _ = log.write_all(&buf[..n]);
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // The pipe closed: release any partial last line, redacted.
        if let Ok(mut log) = sink.lock() {
            let _ = log.finish();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn respawn_log_opens_in_append_mode_and_keeps_crash_evidence() {
        // Regression: a respawn used to reopen the log with File::create (truncate),
        // erasing the crash traceback it exists to explain. A respawn must APPEND
        // and mark the boundary.
        let dir = std::env::temp_dir().join(format!("flowmap-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        std::fs::write(&path, "Traceback (most recent call last): ...\n").unwrap();

        {
            let _log = open_sidecar_log(&path, 1).expect("respawn open");
        } // drop before reading
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("Traceback (most recent call last)"));
        assert!(contents.contains("--- respawn #1 ---"));
        assert!(contents.contains("T") && contents.ends_with("Z ---\n")); // dated

        // A second respawn appends again, keeping everything before it.
        {
            let _log = open_sidecar_log(&path, 2).expect("second respawn open");
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("Traceback (most recent call last)"));
        assert!(contents.contains("--- respawn #1 ---"));
        assert!(contents.contains("--- respawn #2 ---"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_spawn_of_a_run_starts_a_fresh_log() {
        // spawn_index 0 starts a fresh log for this run; the previous run's log
        // moves aside instead of being erased (see the next test).
        let dir = std::env::temp_dir().join(format!("flowmap-log-test0-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        std::fs::write(&path, "stale bytes from the previous run").unwrap();
        {
            let _log = open_sidecar_log(&path, 0).expect("first open");
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_spawn_keeps_the_previous_run_log_as_previous() {
        // Crash, then relaunch: the traceback must survive the relaunch.
        let dir = std::env::temp_dir().join(format!("flowmap-log-prev-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        std::fs::write(&path, "Traceback (most recent call last): crash\n").unwrap();
        {
            let _log = open_sidecar_log(&path, 0).expect("first open");
        }
        let previous = std::fs::read_to_string(dir.join("flowmap-server.previous.log")).unwrap();
        assert!(previous.contains("Traceback (most recent call last): crash"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_current_log_keeps_the_older_previous_copy() {
        // Two launches in a row where the server wrote nothing on the first: the
        // rotation must not delete the crash kept from before, when there is no
        // current log to move aside.
        let dir = std::env::temp_dir().join(format!("flowmap-log-keep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        let previous = dir.join("flowmap-server.previous.log");
        std::fs::write(
            &previous,
            "Traceback (most recent call last): older crash\n",
        )
        .unwrap();
        {
            let _log = open_sidecar_log(&path, 0).expect("first open");
        }
        let kept = std::fs::read_to_string(&previous).unwrap();
        assert!(kept.contains("older crash"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotating_log_caps_the_file_and_keeps_one_previous_generation() {
        let dir = std::env::temp_dir().join(format!("flowmap-rotate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("server.log");
        let mut log = RotatingLog::open(&path, 64).unwrap();
        for _ in 0..3 {
            log.write_all(&[b'x'; 40]).unwrap(); // 40 + 40 > 64: each write after the first rotates
        }
        log.flush().unwrap();
        let current = std::fs::metadata(&path).unwrap().len();
        assert!(current <= 64, "current log is {current} bytes");
        assert!(dir.join("server.previous.log").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
