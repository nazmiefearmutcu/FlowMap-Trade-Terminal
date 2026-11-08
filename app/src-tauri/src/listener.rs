//! Proves that the process listening on a loopback port is the sidecar this shell
//! started.
//!
//! The shell picks a free port and gives it to the sidecar, so another process
//! can take the port first. The session token must never reach that process. The
//! check is the operating system's own record of who owns the listening socket:
//! the shell asks whether the sidecar's PID owns a listener on the port, and only
//! then sends the token there. No cooperation from the server is needed.

use std::process::Child;
use std::time::{Duration, Instant};

/// How often the startup wait looks at the sidecar.
const LISTENER_POLL: Duration = Duration::from_millis(50);

/// Longest the macOS ownership query may run. A slow `lsof` must not hold up the
/// supervisor's ticks, so a query that overruns counts as "not owned".
#[cfg(target_os = "macos")]
const LSOF_TIMEOUT: Duration = Duration::from_secs(2);

/// Wait until `child` owns a listener on `port`. Fails when the child exits first
/// (for example, it could not bind the port) or when `timeout` passes.
pub(crate) fn wait_until_owned(
    child: &mut Child,
    port: u16,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("the server exited ({status}) before it listened"));
        }
        if owned_by(port, child.id()) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the port was not taken within {} s",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(LISTENER_POLL);
    }
}

/// True when process `pid` owns a TCP listener on 127.0.0.1:`port`.
#[cfg(windows)]
pub(crate) fn owned_by(port: u16, pid: u32) -> bool {
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;
    /// MIB_TCP_STATE_LISTEN.
    const LISTEN_STATE: u32 = 2;

    let mut size: u32 = 0;
    // The table can grow between the sizing call and the read, so retry a few times.
    for _ in 0..4 {
        // u64 storage keeps the buffer aligned for the table header.
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let buffer: Option<*mut std::ffi::c_void> = if buf.is_empty() {
            None
        } else {
            Some(buf.as_mut_ptr().cast())
        };
        // SAFETY: `buffer` is either null or points at `size` writable bytes, and
        // `size` is the length the call reports back.
        let status = unsafe {
            GetExtendedTcpTable(
                buffer,
                &mut size,
                false,
                u32::from(AF_INET.0),
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER.0 {
            continue;
        }
        if status != NO_ERROR.0 {
            return false;
        }
        let table = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
        // SAFETY: the call succeeded, so the buffer holds the table header followed
        // by `dwNumEntries` rows.
        let rows = unsafe {
            let count = (*table).dwNumEntries as usize;
            std::slice::from_raw_parts((*table).table.as_ptr(), count)
        };
        return rows.iter().any(|row: &MIB_TCPROW_OWNER_PID| {
            row.dwState == LISTEN_STATE
                && row.dwOwningPid == pid
                // The port is in network byte order in the low 16 bits.
                && u16::from_be(row.dwLocalPort as u16) == port
        });
    }
    false
}

/// True when process `pid` owns a TCP listener on 127.0.0.1:`port`.
#[cfg(target_os = "linux")]
pub(crate) fn owned_by(port: u16, pid: u32) -> bool {
    let Ok(table) = std::fs::read_to_string("/proc/net/tcp") else {
        return false;
    };
    let Some(inode) = listening_inode(&table, port) else {
        return false;
    };
    let wanted = format!("socket:[{inode}]");
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    fds.flatten().any(|fd| {
        std::fs::read_link(fd.path()).is_ok_and(|target| target.to_string_lossy() == wanted)
    })
}

/// The socket inode of the 127.0.0.1 LISTEN entry on `port` in the text of a
/// /proc/net/tcp table. Takes the text rather than the path, so the parser is
/// tested on every platform.
#[cfg(any(target_os = "linux", test))]
fn listening_inode(table: &str, port: u16) -> Option<u64> {
    /// 127.0.0.1 as /proc prints it (little-endian hex), and the LISTEN state.
    const LOOPBACK: &str = "0100007F";
    const LISTEN: &str = "0A";
    table.lines().skip(1).find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (address, local_port) = fields.get(1)?.split_once(':')?;
        if fields.get(3)? != &LISTEN
            || address != LOOPBACK
            || u16::from_str_radix(local_port, 16).ok()? != port
        {
            return None;
        }
        fields.get(9)?.parse().ok()
    })
}

/// True when process `pid` owns a TCP listener on 127.0.0.1:`port`.
#[cfg(target_os = "macos")]
pub(crate) fn owned_by(port: u16, pid: u32) -> bool {
    use std::process::{Command, Stdio};
    // `-t` prints bare PIDs; `-a` ANDs the filters: this process and this port.
    // The absolute path: a Finder-launched app may not have /usr/sbin on its PATH.
    let mut command = Command::new("/usr/sbin/lsof");
    command
        .args(["-nP", "-t", "-a", "-p"])
        .arg(pid.to_string())
        .arg(format!("-iTCP:{port}"))
        .arg("-sTCP:LISTEN")
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    output_within(command, LSOF_TIMEOUT).is_some_and(|stdout| lsof_lists_pid(&stdout, pid))
}

/// Whether `lsof -t` output names `pid`. One bare PID per line.
#[cfg(any(target_os = "macos", test))]
fn lsof_lists_pid(stdout: &str, pid: u32) -> bool {
    let wanted = pid.to_string();
    stdout.lines().any(|line| line.trim() == wanted)
}

/// Run `command` and return its stdout when it exits within `timeout`. A command
/// that overruns is killed and reported as None.
#[cfg(any(target_os = "macos", test))]
fn output_within(mut command: std::process::Command, timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    command.stdout(Stdio::piped());
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(LISTENER_POLL),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut stdout = String::new();
    child.stdout.take()?.read_to_string(&mut stdout).ok()?;
    Some(stdout)
}

/// Other platforms have no ownership check, so no token is ever sent there.
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub(crate) fn owned_by(_port: u16, _pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// A /proc/net/tcp table: a loopback listener on 9000 (0x2328) owned by inode
    /// 12345, an ESTABLISHED socket on 9001 and an any-address listener on 9002.
    const PROC_TABLE: &str = "\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:2328 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:2329 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 54321 1 0000000000000000 100 0 0 10 0
   2: 00000000:232A 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 99999 1 0000000000000000 100 0 0 10 0
";

    #[test]
    fn the_proc_table_names_the_loopback_listener_only() {
        assert_eq!(listening_inode(PROC_TABLE, 9000), Some(12345));
        assert_eq!(
            listening_inode(PROC_TABLE, 9001),
            None,
            "an established socket is not a listener"
        );
        assert_eq!(
            listening_inode(PROC_TABLE, 9002),
            None,
            "a listener on another address is not the loopback one"
        );
        assert_eq!(listening_inode(PROC_TABLE, 9003), None);
        assert_eq!(listening_inode("", 9000), None);
    }

    #[test]
    fn lsof_output_must_name_the_pid_exactly() {
        assert!(lsof_lists_pid("4242\n", 4242));
        assert!(lsof_lists_pid("  4242  \n", 4242));
        assert!(!lsof_lists_pid("42\n", 4242), "a prefix is another PID");
        assert!(!lsof_lists_pid("424242\n", 4242));
        assert!(!lsof_lists_pid("", 4242));
    }

    #[test]
    fn a_query_that_finishes_in_time_returns_its_output() {
        #[cfg(windows)]
        let command = {
            let mut command = std::process::Command::new("cmd");
            command.args(["/C", "echo 4242"]);
            command
        };
        #[cfg(unix)]
        let command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "echo 4242"]);
            command
        };
        let stdout = output_within(command, Duration::from_secs(20));
        assert_eq!(stdout.as_deref().map(str::trim), Some("4242"));
    }

    #[test]
    fn a_query_that_overruns_its_budget_is_abandoned() {
        #[cfg(windows)]
        let command = {
            let mut command = std::process::Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ]);
            command
        };
        #[cfg(unix)]
        let command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        };
        let started = Instant::now();
        assert_eq!(
            output_within(command, Duration::from_millis(300)),
            None,
            "an overrunning query counts as no answer"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it must not wait for the child to finish"
        );
    }

    #[test]
    fn a_listener_is_owned_by_the_process_that_holds_it_and_by_no_other() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().unwrap().port();
        assert!(
            owned_by(port, std::process::id()),
            "the holder must be recognised"
        );
        assert!(
            !owned_by(port, u32::MAX),
            "another PID must not be recognised"
        );
        drop(listener);
    }

    #[test]
    fn a_port_nobody_listens_on_is_owned_by_nobody() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
            listener.local_addr().unwrap().port()
        };
        assert!(!owned_by(port, std::process::id()));
    }

    #[test]
    fn a_child_that_exits_before_listening_fails_fast() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("cmd")
            .args(["/C", "exit 0"])
            .spawn()
            .expect("test child");
        #[cfg(unix)]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .expect("test child");
        let started = Instant::now();
        let result = wait_until_owned(&mut child, 9, Duration::from_secs(20));
        assert!(result.is_err(), "a child that never listens must fail");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it must not wait out the timeout"
        );
    }
}
