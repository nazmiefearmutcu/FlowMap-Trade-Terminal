//! Native message dialogs for the failures that happen before, or without, the
//! webview: the Win32 message box on Windows, `osascript` on macOS, and zenity,
//! kdialog or a desktop notification elsewhere.

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
};

#[cfg(not(windows))]
use std::process::Command;

#[cfg(not(windows))]
use crate::shell_log;

/// UTF-16 (NUL-terminated) for the Win32 wide-string APIs.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
pub(crate) fn show_native_dialog(title: &str, message: &str) {
    let body = wide(message);
    let caption = wide(title);
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(caption.as_ptr()),
            MB_ICONERROR | MB_OK | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

/// The AppleScript that shows the error dialog. Pure, so the quoting is tested on every
/// platform, not only on a Mac.
#[cfg(any(test, target_os = "macos"))]
fn applescript_dialog(title: &str, message: &str) -> String {
    // AppleScript string literals: escape backslashes and quotes, join lines with `return`.
    let quoted = message
        .split('\n')
        .map(|line| format!("\"{}\"", line.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" & return & ");
    let title = title.replace('\\', "\\\\").replace('"', "\\\"");
    format!(
        "display dialog {quoted} with title \"{title}\" with icon stop buttons {{\"OK\"}} default button \"OK\""
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn show_native_dialog(title: &str, message: &str) {
    let script = applescript_dialog(title, message);
    if let Err(err) = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .status()
    {
        shell_log(&format!("could not show the native dialog: {err}"));
    }
}

/// The Linux dialog tools in the order they are tried, each with its arguments: zenity
/// (GNOME), kdialog (KDE), then a desktop notification, which needs no dialog tool. Pure,
/// so the argument lists are tested on every platform.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn linux_dialog_commands(title: &str, message: &str) -> Vec<(&'static str, Vec<String>)> {
    vec![
        (
            "zenity",
            vec![
                "--error".into(),
                "--no-markup".into(),
                "--title".into(),
                title.into(),
                "--text".into(),
                message.into(),
            ],
        ),
        (
            "kdialog",
            vec![
                "--error".into(),
                message.into(),
                "--title".into(),
                title.into(),
            ],
        ),
        (
            "notify-send",
            vec![
                "--app-name=FlowMap".into(),
                "--urgency=critical".into(),
                "--".into(),
                title.into(),
                markup_escaped(message),
            ],
        ),
    ]
}

/// Notification bodies are read as markup by most servers, so the text is escaped.
#[cfg(any(test, all(unix, not(target_os = "macos"))))]
fn markup_escaped(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn show_native_dialog(title: &str, message: &str) {
    for (tool, args) in linux_dialog_commands(title, message) {
        // The first tool that starts has taken the message. A tool that is not installed
        // fails to start, and the next one is tried. A tool that starts but exits with a
        // failure (for example no display, or no notification server) is logged, since
        // the message then reached nobody.
        match Command::new(tool).args(&args).status() {
            Ok(status) => {
                if !status.success() {
                    shell_log(&format!(
                        "{tool} exited with {status} while showing a dialog"
                    ));
                }
                return;
            }
            Err(_) => continue,
        }
    }
    shell_log("no dialog tool (zenity, kdialog or notify-send) could start; the message is only in this log");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_linux_dialog_tool_gets_the_title_and_the_whole_message() {
        let commands = linux_dialog_commands("FlowMap", "first line\nsecond -line");
        let tools: Vec<&str> = commands.iter().map(|(tool, _)| *tool).collect();
        assert_eq!(tools, ["zenity", "kdialog", "notify-send"]);
        for (tool, args) in &commands {
            assert!(
                args.iter().any(|arg| arg == "FlowMap"),
                "{tool} shows the title"
            );
            assert!(
                args.iter()
                    .any(|arg| arg.contains("first line") && arg.contains("second -line")),
                "{tool} shows the whole message"
            );
        }
    }

    #[test]
    fn the_applescript_quotes_the_message_and_joins_its_lines() {
        assert_eq!(
            applescript_dialog("FlowMap", "first\nsecond"),
            "display dialog \"first\" & return & \"second\" with title \"FlowMap\" with icon stop buttons {\"OK\"} default button \"OK\""
        );
    }

    #[test]
    fn the_applescript_escapes_quotes_and_backslashes_in_the_message_and_title() {
        let script = applescript_dialog("Fl\"ow", r#"say "hi" \ now"#);
        assert!(
            script.starts_with(r#"display dialog "say \"hi\" \\ now" with title "Fl\"ow""#),
            "{script}"
        );
    }

    #[test]
    fn a_notification_body_is_read_as_text_not_markup() {
        assert_eq!(markup_escaped("a <b> & c"), "a &lt;b&gt; &amp; c");
        let commands = linux_dialog_commands("FlowMap", "<i>x</i>");
        let (tool, args) = commands.last().expect("notify-send is the last fallback");
        assert_eq!(*tool, "notify-send");
        assert_eq!(
            args.last().map(String::as_str),
            Some("&lt;i&gt;x&lt;/i&gt;")
        );
    }
}
