//! Native message dialogs for the failures that happen before, or without, the
//! webview: the Win32 message box on Windows, `osascript` on macOS, and zenity or
//! kdialog elsewhere.

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

#[cfg(target_os = "macos")]
pub(crate) fn show_native_dialog(title: &str, message: &str) {
    // AppleScript string literals: escape backslashes and quotes, join lines with `return`.
    let quoted = message
        .split('\n')
        .map(|line| format!("\"{}\"", line.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect::<Vec<_>>()
        .join(" & return & ");
    let title = title.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "display dialog {quoted} with title \"{title}\" with icon stop buttons {{\"OK\"}} default button \"OK\""
    );
    if let Err(err) = Command::new("osascript").arg("-e").arg(script).status() {
        shell_log(&format!("could not show the native dialog: {err}"));
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub(crate) fn show_native_dialog(title: &str, message: &str) {
    // zenity (GNOME) first, kdialog (KDE) when zenity is not installed.
    let zenity = Command::new("zenity")
        .args([
            "--error",
            "--no-markup",
            "--title",
            title,
            "--text",
            message,
        ])
        .status();
    let Err(zenity_err) = zenity else { return };
    if let Err(kdialog_err) = Command::new("kdialog")
        .args(["--error", message, "--title", title])
        .status()
    {
        shell_log(&format!(
            "could not show the native dialog (zenity: {zenity_err}; kdialog: {kdialog_err})"
        ));
    }
}
