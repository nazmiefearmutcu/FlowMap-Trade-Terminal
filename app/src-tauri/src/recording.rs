//! The recording switch, persisted in the app-data dir.

use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{shell_log, write_atomically};

/// The recording switch, persisted in the app-data dir.
const RECORDING_PREF_FILE: &str = "recording.json";

/// The boolean `enabled` of a `recording.json` body, or `None` when the body is not a
/// JSON object carrying one.
fn recording_choice(content: &str) -> Option<bool> {
    serde_json::from_str::<serde_json::Value>(content)
        .ok()
        .and_then(|value| value.get("enabled").and_then(serde_json::Value::as_bool))
}

/// The recording switch in the content of `recording.json`. Anything that is not a
/// JSON object with a boolean `enabled` keeps recording on, which is the default for
/// the installed app.
pub(crate) fn parse_recording_pref(content: &str) -> bool {
    recording_choice(content).unwrap_or(true)
}

/// Reads the switch at launch. An absent file is the normal default and is not logged;
/// a file that cannot be read or parsed also keeps recording on, and the shell log says so.
pub(crate) fn read_recording_pref(data_dir: &Path) -> bool {
    let path = data_dir.join(RECORDING_PREF_FILE);
    match fs::read_to_string(&path) {
        Ok(content) => {
            if recording_choice(&content).is_none() {
                shell_log(&format!(
                    "{} is not a recording switch; recording stays on",
                    path.display()
                ));
            }
            parse_recording_pref(&content)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => true,
        Err(err) => {
            shell_log(&format!(
                "could not read {}; recording stays on: {err}",
                path.display()
            ));
            true
        }
    }
}

/// Write the switch through a temporary file, so a crash never leaves half a file.
pub(crate) fn write_recording_pref(data_dir: &Path, enabled: bool) -> io::Result<()> {
    fs::create_dir_all(data_dir)?;
    write_atomically(
        &data_dir.join(RECORDING_PREF_FILE),
        serde_json::json!({ "enabled": enabled })
            .to_string()
            .as_bytes(),
    )
}

/// Stores the recording switch and reports whether its value changed. Only a real
/// change needs a sidecar restart, so repeating the current value costs nothing.
pub(crate) fn swap_recording(current: &AtomicBool, enabled: bool) -> bool {
    current.swap(enabled, Ordering::Relaxed) != enabled
}

/// The FLOWMAP_RECORDING_ENABLED value. The benchmark build always records, because
/// its harness measures the recorder.
pub(crate) fn recording_env(benchmark: bool, enabled: bool) -> &'static str {
    if benchmark || enabled {
        "1"
    } else {
        "0"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_switch_defaults_to_on_and_reads_only_a_boolean_choice() {
        assert!(parse_recording_pref(""), "no file keeps recording on");
        assert!(
            parse_recording_pref("not json"),
            "a corrupt file keeps recording on"
        );
        assert!(parse_recording_pref("{}"));
        assert!(
            parse_recording_pref(r#"{"enabled":"no"}"#),
            "only a JSON boolean counts"
        );
        assert!(!parse_recording_pref(r#"{"enabled":false}"#));
        assert!(parse_recording_pref(r#"{"enabled":true}"#));
    }

    #[test]
    fn the_saved_switch_is_read_back_and_no_file_keeps_recording_on() {
        let dir = std::env::temp_dir().join(format!("flowmap-recording-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(read_recording_pref(&dir), "no file keeps recording on");
        write_recording_pref(&dir, false).expect("save the switch");
        assert!(
            !read_recording_pref(&dir),
            "the saved off choice is read back"
        );
        write_recording_pref(&dir, true).expect("save the switch");
        assert!(
            read_recording_pref(&dir),
            "the saved on choice is read back"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_recording_env_follows_the_switch_except_in_the_benchmark() {
        assert_eq!(recording_env(false, true), "1");
        assert_eq!(
            recording_env(false, false),
            "0",
            "the server reads 0 as off"
        );
        assert_eq!(
            recording_env(true, false),
            "1",
            "the benchmark always records"
        );
    }

    #[test]
    fn only_a_real_change_of_the_recording_switch_restarts_the_sidecar() {
        let switch = AtomicBool::new(true);
        assert!(
            !swap_recording(&switch, true),
            "repeating the value changes nothing"
        );
        assert!(swap_recording(&switch, false), "on to off is a change");
        assert!(!switch.load(Ordering::Relaxed));
        assert!(
            !swap_recording(&switch, false),
            "repeating off changes nothing"
        );
        assert!(swap_recording(&switch, true), "off to on is a change");
        assert!(switch.load(Ordering::Relaxed));
    }

    #[test]
    fn the_recording_switch_survives_a_write_and_a_read() {
        let dir = std::env::temp_dir().join(format!("flowmap-rec-pref-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_recording_pref(&dir), "a fresh profile records");
        write_recording_pref(&dir, false).expect("write off");
        assert!(!read_recording_pref(&dir));
        write_recording_pref(&dir, true).expect("write on");
        assert!(read_recording_pref(&dir));
        assert!(
            !dir.join("recording.json.tmp").exists(),
            "the temporary file is renamed away"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
