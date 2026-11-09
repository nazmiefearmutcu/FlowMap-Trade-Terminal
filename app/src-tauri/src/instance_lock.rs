//! The single-instance guard and the "already running" hand-off.
//!
//! Two shells would race the recorder's disk-scan part numbering and corrupt each
//! other's recordings, so the shell holds an OS-level advisory lock on a sentinel
//! file in the app-data dir for its whole life.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};

use crate::ensure_private_dir;

/// Bring the running FlowMap window forward (Windows). Only a visible top-level
/// window titled "FlowMap" that belongs to `holder` (the PID the running instance
/// wrote into the lock file) counts, so an unrelated window with the same title,
/// such as an Explorer folder, is never focused. Returns false when no such
/// window was found, so the caller can show the message instead.
#[cfg(windows)]
pub(crate) fn focus_existing_window(holder: Option<u32>) -> bool {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    struct Search {
        holder: u32,
        found: Option<HWND>,
    }

    extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `&mut Search` handed to EnumWindows below, and it
        // outlives that call; EnumWindows runs the callback on this thread only.
        unsafe {
            let search = &mut *(lparam.0 as *mut Search);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
            if pid != search.holder || !IsWindowVisible(hwnd).as_bool() {
                return BOOL(1);
            }
            // Sized for "FlowMap" plus the terminator; longer titles never match.
            let mut title = [0u16; 16];
            let len = GetWindowTextW(hwnd, &mut title);
            if String::from_utf16_lossy(&title[..len.max(0) as usize]) == "FlowMap" {
                search.found = Some(hwnd);
                return BOOL(0);
            }
            BOOL(1)
        }
    }

    let Some(holder) = holder else {
        return false;
    };
    let mut search = Search {
        holder,
        found: None,
    };
    // Stopping the walk early makes EnumWindows report failure; `found` is what counts.
    let _ = unsafe { EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize)) };
    match search.found {
        Some(hwnd) => unsafe {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            let _ = SetForegroundWindow(hwnd);
            true
        },
        None => false,
    }
}

#[cfg(not(windows))]
pub(crate) fn focus_existing_window(_holder: Option<u32>) -> bool {
    false
}

/// The sentinel file holds one decimal PID (plus trailing newline). Diagnostic
/// only — the OS-held lock, not this text, decides liveness.
fn parse_lock_pid(content: &str) -> Option<u32> {
    content.trim().parse::<u32>().ok()
}

/// The PID of the instance that holds the lock, as written into the lock file.
pub(crate) fn lock_holder_pid(data_dir: &Path) -> Option<u32> {
    fs::read_to_string(data_dir.join("flowmap.lock"))
        .ok()
        .and_then(|content| parse_lock_pid(&content))
}

/// The single-instance guard: an advisory-locked file held open for the whole
/// process lifetime. The OS drops the lock on exit or crash, so there is no
/// stale-file takeover logic. The file itself is never deleted (see `release`).
#[derive(Debug)]
pub(crate) struct InstanceGuard {
    _file: File,
}

#[derive(Debug)]
pub(crate) enum LockError {
    /// Another live FlowMap process holds the lock.
    AlreadyRunning,
    Io(std::io::Error),
}

/// Acquire the single-instance advisory lock on `flowmap.lock`.
///
/// The LOCK ITSELF (an OS-held advisory file lock via `File::try_lock`) is the
/// authority, not the file's existence or contents: the OS releases it
/// automatically when the holding process exits OR CRASHES, so there is no
/// stale lockfile to second-guess. PID-liveness probing had two failure modes
/// ending in the exact two-shell recording corruption this guard exists to
/// prevent — a recycled PID reading "alive" forever, and an `OpenProcess`
/// permission failure deleting a LIVE instance's lockfile. The PID inside the
/// file is diagnostic text only.
pub(crate) fn acquire_instance_lock(data_dir: &Path) -> Result<InstanceGuard, LockError> {
    ensure_private_dir(data_dir).map_err(LockError::Io)?;
    let path = data_dir.join("flowmap.lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(LockError::Io)?;
    match file.try_lock() {
        Ok(()) => {
            // Diagnostic content only — never trusted for liveness.
            let _ = file.set_len(0);
            let _ = write!(file, "{}", std::process::id());
            let _ = file.sync_all();
            Ok(InstanceGuard { _file: file })
        }
        // Another live FlowMap process holds the lock.
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::AlreadyRunning),
        Err(std::fs::TryLockError::Error(err)) => Err(LockError::Io(err)),
    }
}

impl InstanceGuard {
    /// Drop the lock on a clean exit. The sentinel file stays where it is: deleting
    /// it after unlocking let a starting instance lock the old file while a third
    /// one created a fresh file and locked that too, so two shells could run at once.
    pub(crate) fn release(self) {
        drop(self._file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_pid_parses_decimal_with_newline() {
        assert_eq!(parse_lock_pid("1234\n"), Some(1234));
        assert_eq!(parse_lock_pid(" 42 "), Some(42));
        assert_eq!(parse_lock_pid(""), None);
        assert_eq!(parse_lock_pid("not-a-pid"), None);
        assert_eq!(parse_lock_pid("4294967296"), None); // out of u32 range
    }

    #[test]
    fn a_second_lock_acquirement_reports_already_running() {
        // The real two-instance scenario, in-process: the first guard HOLDS the
        // OS lock, so a second acquirement on the same path must be refused.
        let dir = std::env::temp_dir().join(format!("flowmap-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _first = acquire_instance_lock(&dir).expect("first acquire");
        match acquire_instance_lock(&dir) {
            Err(LockError::AlreadyRunning) => {}
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sentinel_survives_a_clean_release_so_no_second_file_is_created() {
        // Deleting the file after unlocking let a third instance lock a fresh file
        // while a second one held the old inode. The file must stay in place.
        let dir = std::env::temp_dir().join(format!("flowmap-lock-keep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let guard = acquire_instance_lock(&dir).expect("first acquire");
        let sentinel = dir.join("flowmap.lock");
        guard.release();
        assert!(
            sentinel.exists(),
            "the sentinel must not be deleted on release"
        );
        assert_eq!(lock_holder_pid(&dir), Some(std::process::id()));
        // On unix the lock belongs to the open file description. Another test thread
        // that spawns a child process at this moment hands the child a duplicate of
        // it between fork and exec, so the lock can stay held for an instant after
        // the release. Wait for that duplicate to close before judging the result.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let again = loop {
            match acquire_instance_lock(&dir) {
                Ok(guard) => break guard,
                Err(LockError::AlreadyRunning) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(other) => panic!("lock is free after release: {other:?}"),
            }
        };
        again.release();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
