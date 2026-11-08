//! The sidecar process: spawning it with the shell's launch settings, the child
//! handles that keep it tied to the shell, and stopping it again.
//!
//! The shell runs the FlowMap Python server as a child process. Everything here
//! concerns that one process; the restart policy that decides when to spawn it
//! again lives in `supervisor`.

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::ops::{Deref, DerefMut};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(windows)]
use windows::core::PCWSTR;

use crate::dialog_text::Lang;
use crate::lock_or_recover;
use crate::recording::recording_env;
use crate::redact::RedactingSink;
use crate::server_log::{open_sidecar_log, pump_output};
use crate::shell_log;

/// The server's whole shutdown flush budget, in whole seconds: `SHUTDOWN_FLUSH_DEADLINE_S`
/// in server/src/flowmap_server/core/session_common.py. Its recording drain is bounded
/// inside this budget.
const SERVER_FLUSH_DEADLINE_SECS: u64 = 11;
/// Time a quit gives the sidecar to flush and exit after its stdin closes. It is the
/// server's flush budget plus a margin, so a slow final flush is not cut short. The
/// trade-off: closing the window can take this long when the disk is wedged. A sidecar
/// still running when it ends is killed, and the kill is logged.
pub(crate) const GRACEFUL_STOP: Duration = Duration::from_secs(SERVER_FLUSH_DEADLINE_SECS + 1);
/// Time an automatic restart gives a sidecar that crashed or stopped answering before it
/// is killed. Such a sidecar is not flushing a recorder the user asked to stop, so the
/// restart does not wait out the whole flush budget. A sidecar that already exited needs
/// no wait at all.
pub(crate) const RESTART_STOP: Duration = Duration::from_secs(3);
const _: () = assert!(GRACEFUL_STOP.as_secs() > SERVER_FLUSH_DEADLINE_SECS);
const _: () = assert!(RESTART_STOP.as_secs() < GRACEFUL_STOP.as_secs());

/// Environment variable carrying the session token to the sidecar.
const SESSION_TOKEN_ENV: &str = "FLOWMAP_SESSION_TOKEN";
/// Recording size cap passed to the server on every spawn, in GB. The Settings
/// screen shows this value, so the two cannot drift apart.
pub(crate) const RECORDING_GB_CAP: f64 = 20.0;

/// The only environment the sidecar inherits. Everything else is dropped, so a
/// stray FLOWMAP_* variable in the user's shell cannot change how it starts.
const CHILD_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    // Proxies and CA bundles that the server's HTTP clients honour.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    // Optional market-data keys the server reads (SECURITY.md lists them). They are
    // read-only feed credentials, and the child is this app's own server.
    "ALPACA_API_KEY",
    "ALPACA_API_SECRET",
    "FINNHUB_API_KEY",
    // Windows.
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    // Unix.
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_CONFIG_HOME",
];
/// Extra variables the benchmark harness needs; only passed to the benchmark build.
const BENCHMARK_ENV_ALLOWLIST: &[&str] = &["FLOWMAP_BENCHMARK_OWNER", "FLOWMAP_BENCHMARK_PROFILE"];

/// Holds the sidecar child so it can be stopped exactly once on exit.
pub(crate) struct SidecarState(pub(crate) Mutex<Option<ManagedChild>>);

/// Keep the sidecar tied to the shell even if the shell crashes. A Windows
/// child otherwise survives its parent, continuing to record and use memory.
/// The child's stdin is a pipe held open by `process`: closing it is the
/// graceful stop signal (see `stop_child`).
pub(crate) struct ManagedChild {
    process: Child,
    /// The recording switch this process was spawned with. A change of the switch
    /// after the spawn is what makes a restart necessary.
    recording: bool,
    #[cfg(windows)]
    _job: SidecarJob,
}

impl ManagedChild {
    pub(crate) fn new(process: Child, recording: bool) -> Result<Self, Box<dyn std::error::Error>> {
        #[cfg(windows)]
        let job = match SidecarJob::attach(&process) {
            Ok(job) => job,
            Err(err) => {
                let mut process = process;
                let _ = process.kill();
                let _ = process.wait();
                return Err(err.into());
            }
        };
        Ok(Self {
            process,
            recording,
            #[cfg(windows)]
            _job: job,
        })
    }
}

impl Deref for ManagedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.process
    }
}
impl DerefMut for ManagedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.process
    }
}

#[cfg(windows)]
struct SidecarJob {
    // Store the owned handle as an integer so the supervisor can transfer its
    // ownership across threads. No other object closes or inherits this handle.
    handle: usize,
}

#[cfg(windows)]
impl SidecarJob {
    fn attach(child: &Child) -> windows::core::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null())? };
        let job = Self {
            handle: handle.0 as usize,
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )?;
            AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle()))?;
        }
        Ok(job)
    }
}

#[cfg(windows)]
impl Drop for SidecarJob {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{CloseHandle, HANDLE};
        unsafe {
            let _ = CloseHandle(HANDLE(self.handle as *mut std::ffi::c_void));
        }
    }
}

/// Everything a (re)spawn needs. The port and the session token stay the same for
/// the whole app run, so a respawn keeps the values the webview was given valid.
#[derive(Clone)]
pub(crate) struct Launch {
    pub(crate) python: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) log_path: PathBuf,
    pub(crate) port: u16,
    pub(crate) token: String,
    pub(crate) benchmark: bool,
    pub(crate) lang: Lang,
    /// The recording switch. Read at every spawn, so a change applies on restart.
    pub(crate) recording: Arc<AtomicBool>,
}

/// One `GET /api/health` over a short-lived loopback socket; true on `200 ok`.
/// Sends the session token when there is one, so callers must first confirm the
/// listener belongs to the sidecar (see `listener::owned_by`).
pub(crate) fn health_ok(port: u16, token: &str) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let token_header = if token.is_empty() {
        String::new()
    } else {
        format!("X-FlowMap-Token: {token}\r\n")
    };
    let req = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n{token_header}Connection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.contains("200") && buf.contains("\"status\":\"ok\"")
}

/// Stop a sidecar: close its stdin (the EOF the server treats as "stop"), send
/// SIGTERM on unix, wait up to `grace` for it to exit, then kill it.
pub(crate) fn stop_child(child: &mut Child, grace: Duration) {
    // A child that has already exited (and is reaped here) must never be
    // signalled afterwards: its PID could be reused by an unrelated process.
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    drop(child.stdin.take());
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    shell_log(&format!(
        "sidecar did not exit {} s after its stdin closed; killing it, so its final flush may be cut short",
        grace.as_secs()
    ));
    let _ = child.kill();
    let _ = child.wait();
}

/// Stop the managed sidecar, if one is running, waiting up to `grace` before the kill.
/// The state lock is held for the whole stop, so a concurrent exit handler waits for
/// the flush instead of killing the process underneath it.
pub(crate) fn kill_sidecar(state: &SidecarState, grace: Duration) {
    let mut guard = lock_or_recover(&state.0);
    if let Some(mut child) = guard.take() {
        stop_child(&mut child, grace);
    }
}

/// Arguments for the interpreter. `-I` ignores the user's site-packages and
/// PYTHON* variables, so the bundle's own dependency set is what runs. Because
/// `-I` also ignores PYTHONUTF8, UTF-8 stdio is requested with `-X utf8`.
fn sidecar_args(benchmark: bool) -> Vec<&'static str> {
    let mut args = vec!["-I", "-X", "utf8"];
    if benchmark {
        args.push("-B");
    }
    args.extend(["-m", "flowmap_server"]);
    args
}

/// Linux: the kernel sends SIGTERM to the sidecar when the thread that spawned
/// it exits. The spawning threads (setup and the supervisor) live for the whole
/// run, so a SIGKILLed shell cannot leave a recorder behind. macOS uses the
/// stdin EOF instead; Windows uses the job object.
#[cfg(target_os = "linux")]
fn set_parent_death_signal(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    let shell_pid = std::process::id() as libc::pid_t;
    let zero: libc::c_ulong = 0;
    // SAFETY: runs in the forked child before exec and only calls prctl/getppid,
    // which are async-signal-safe.
    unsafe {
        command.pre_exec(move || {
            let signal = libc::SIGTERM as libc::c_ulong;
            if libc::prctl(libc::PR_SET_PDEATHSIG, signal, zero, zero, zero) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            // The shell may have died between fork and prctl; then no signal
            // would ever arrive, so the child stops itself instead.
            if libc::getppid() != shell_pid {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
}

/// Start the sidecar process for `spawn_index` (0 = the first spawn of this run).
pub(crate) fn spawn_sidecar(
    launch: &Launch,
    spawn_index: u32,
) -> Result<ManagedChild, Box<dyn std::error::Error>> {
    let recordings = launch.data_dir.join("recordings");
    fs::create_dir_all(&recordings)?;

    let log = Arc::new(Mutex::new(RedactingSink::new(
        open_sidecar_log(&launch.log_path, spawn_index)?,
        vec![launch.token.clone()],
    )));
    shell_log(&format!(
        "starting sidecar {} -m flowmap_server on :{} (spawn {spawn_index})",
        launch.python.display(),
        launch.port
    ));

    // One read of the switch serves both the environment and the record kept on the
    // child, so the supervisor compares against what this process actually got.
    let recording = launch.recording.load(Ordering::Relaxed);
    let mut command = Command::new(&launch.python);
    command.args(sidecar_args(launch.benchmark));
    command.env_clear();
    for name in CHILD_ENV_ALLOWLIST {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if launch.benchmark {
        for name in BENCHMARK_ENV_ALLOWLIST {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        command.env(
            "FLOWMAP_BENCHMARK_PROVENANCE",
            launch.data_dir.join("sidecar-provenance.json"),
        );
    }
    command
        .env("FLOWMAP_HOST", "127.0.0.1")
        .env("FLOWMAP_PORT", launch.port.to_string())
        .env(
            "FLOWMAP_RECORDING_ENABLED",
            recording_env(launch.benchmark, recording),
        )
        .env("FLOWMAP_RECORDING_GB_CAP", RECORDING_GB_CAP.to_string())
        .env("FLOWMAP_DATA_DIR", &recordings)
        .env(SESSION_TOKEN_ENV, &launch.token)
        // Graceful stop: the server exits through uvicorn's normal path,
        // flushing its recorder, when its stdin reaches EOF. That is how the shell
        // stops or loses it. The kill after GRACEFUL_STOP is only the fallback.
        .env("FLOWMAP_EXIT_ON_STDIN_EOF", "1")
        .current_dir(&launch.data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "linux")]
    set_parent_death_signal(&mut command);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW.0);
    }

    let mut child = command.spawn()?;
    if let Some(stdout) = child.stdout.take() {
        pump_output(stdout, Arc::clone(&log));
    }
    if let Some(stderr) = child.stderr.take() {
        pump_output(stderr, log);
    }
    ManagedChild::new(child, recording)
}

/// The recording switch the child in the sidecar slot was spawned with, or None when
/// the slot is empty.
pub(crate) fn child_recording(state: &SidecarState) -> Option<bool> {
    lock_or_recover(&state.0)
        .as_ref()
        .map(|child| child.recording)
}

/// What the supervisor found when it looked at the sidecar slot.
pub(crate) enum ChildCheck {
    Exited,
    /// The child is running; carries its PID.
    Running(u32),
    Missing,
}

/// Look at the sidecar slot. An exited child is reaped and dropped from it.
pub(crate) fn check_child(state: &SidecarState) -> ChildCheck {
    let mut guard = lock_or_recover(&state.0);
    let check = match guard.as_mut() {
        None => ChildCheck::Missing,
        Some(child) => {
            if matches!(child.try_wait(), Ok(Some(_))) {
                ChildCheck::Exited
            } else {
                ChildCheck::Running(child.id())
            }
        }
    };
    if matches!(check, ChildCheck::Exited) {
        guard.take();
    }
    check
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn closing_the_sidecar_job_terminates_its_process() {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 30",
            ])
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .expect("test child");
        let job = SidecarJob::attach(&child).expect("attach child to private job");
        assert!(child.try_wait().unwrap().is_none());
        drop(job);
        // Generous on purpose: a loaded Windows runner can take seconds to tear down.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("child survived its job owner");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn stop_child_exits_on_stdin_eof_without_the_kill_fallback() {
        // The server stops on stdin EOF. The child below does exactly that, so it
        // must be gone well before the grace period ends (the kill path would
        // take the whole grace period).
        let grace = Duration::from_secs(15);
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;
            let mut command = Command::new("powershell.exe");
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[Console]::In.ReadToEnd() | Out-Null",
                ])
                .creation_flags(CREATE_NO_WINDOW.0);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "cat > /dev/null"]);
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child");
        let started = Instant::now();
        stop_child(&mut child, grace);
        assert!(started.elapsed() < grace, "child needed the kill fallback");
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn the_provider_keys_the_security_notes_name_reach_the_sidecar() {
        // SECURITY.md says these are read from the environment when present. The server
        // reads them from the child's environment (config.py), so the allowlist must carry
        // them under the exact names it reads.
        for name in ["ALPACA_API_KEY", "ALPACA_API_SECRET", "FINNHUB_API_KEY"] {
            assert!(
                CHILD_ENV_ALLOWLIST.contains(&name),
                "{name} must reach the sidecar"
            );
        }
        assert!(
            CHILD_ENV_ALLOWLIST
                .iter()
                .all(|name| !name.starts_with("FLOWMAP_")),
            "stray FLOWMAP_* variables stay out of the child"
        );
    }

    #[test]
    fn sidecar_args_isolate_the_interpreter_and_force_utf8() {
        let normal = sidecar_args(false);
        assert!(normal.contains(&"-I"), "user site-packages must be ignored");
        assert!(normal.windows(2).any(|pair| pair == ["-X", "utf8"]));
        assert!(!normal.contains(&"-B"));
        assert_eq!(normal.last(), Some(&"flowmap_server"));
        assert!(sidecar_args(true).contains(&"-B"));
    }

    /// A one-shot loopback server for the health probe. It answers
    /// `200 {"status":"ok"}` only when the request carries `token` in the
    /// `X-FlowMap-Token` header, and `401` otherwise.
    fn health_server(token: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = listener.local_addr().expect("local address").port();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut request = Vec::new();
            let mut chunk = [0u8; 256];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => request.extend_from_slice(&chunk[..read]),
                }
            }
            let request = String::from_utf8_lossy(&request);
            let reply = if request.contains(&format!("X-FlowMap-Token: {token}\r\n")) {
                "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"status\":\"ok\"}"
            } else {
                "HTTP/1.0 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"
            };
            let _ = stream.write_all(reply.as_bytes());
        });
        port
    }

    #[test]
    fn health_is_ok_when_the_session_token_is_presented() {
        let port = health_server("the-session-token");
        assert!(health_ok(port, "the-session-token"));
    }

    #[test]
    fn health_is_not_ok_for_a_wrong_token() {
        let port = health_server("the-session-token");
        assert!(
            !health_ok(port, "another-token"),
            "a listener that rejects the token is not the sidecar"
        );
    }
}
