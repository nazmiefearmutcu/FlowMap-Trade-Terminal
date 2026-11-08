// FlowMap desktop shell (Tauri 2).
//
// Wraps the built WebGL2 client and runs the FlowMap Python server as a bundled
// sidecar so the app is fully self-contained (no user-side Python/Node install):
//
//   1. pick a free loopback TCP port and create a 256-bit session token;
//   2. spawn `<bundled pyruntime>/bin/python3.13 -I -X utf8 -m flowmap_server`
//      bound to that port with the token in FLOWMAP_SESSION_TOKEN, recording
//      under the app-data dir, output captured into a size-capped log file;
//   3. once the operating system confirms that the sidecar owns the port (see
//      `listener`), create the webview with an initialization script that injects
//      the server origin and the session token BEFORE the client JS runs, so the
//      SPA can reach the sidecar's REST and WebSocket endpoints;
//   4. on quit (window close or Cmd-Q) stop the sidecar gracefully: close its
//      stdin (EOF is the server's stop signal), SIGTERM on unix,
//      then SIGKILL after a short grace period. The sidecar also dies with the
//      shell: a Linux parent-death signal, the stdin EOF on macOS (the server
//      exits on it when FLOWMAP_EXIT_ON_STDIN_EOF=1), and a kill-on-close job
//      object on Windows;
//   5. guard against a second instance via an OS-held advisory lock on a
//      sentinel file under the app-data dir (two shells would race the
//      recorder's disk-scan part numbering and corrupt recordings); the OS
//      releases the lock on exit or crash, so no stale-file takeover exists;
//   6. supervise the sidecar for the rest of the run: restart it when it exits
//      or stops answering /api/health, with exponential backoff and a bounded
//      budget, and publish every phase change as a `sidecar-status` event.
//
// Startup failures are fatal WITHOUT panicking: the Windows GUI subsystem has
// no console, so a panic (or a `?` in setup) dies silently. Everything that can
// fail before the window exists goes through `fatal` (a native dialog on every
// platform, then a clean exit). Shell lifecycle messages also go to shell.log in
// the app-data dir, because release Windows builds have no console at all.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod dialog_text;
mod instance_lock;
mod listener;
mod native_dialog;
mod recording;
mod redact;
mod server_log;
mod sidecar;
mod supervisor;
mod window_state;

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use dialog_text::{detect_lang, text, Key, Lang};
use instance_lock::{
    acquire_instance_lock, focus_existing_window, lock_holder_pid, InstanceGuard, LockError,
};
use native_dialog::show_native_dialog;
use recording::{read_recording_pref, swap_recording, write_recording_pref};
use server_log::rotate_to_previous;
use sidecar::{
    kill_sidecar, spawn_sidecar, stop_child, Launch, SidecarState, GRACEFUL_STOP, RECORDING_GB_CAP,
};
use supervisor::{
    publish, retry_sidecar, sidecar_status, spawn_supervisor, Phase, Supervisor, SupervisorCommand,
    STARTUP_HEALTH_TIMEOUT,
};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use window_state::{
    current_window_state, logical_areas, place_window, read_window_state, write_window_state,
};

/// The shell log is moved aside to `shell.previous.log` at this size.
const SHELL_LOG_MAX_BYTES: u64 = 1024 * 1024;

/// Set just before teardown begins; the supervisor reads it to stand down
/// instead of respawning into a dying process.
struct ShutdownState(AtomicBool);

/// Managed so the exit handlers can release the single-instance sentinel.
struct InstanceState(Mutex<Option<InstanceGuard>>);

/// Lock a mutex, recovering the guard when a previous holder panicked.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Bind :0 on loopback, read the assigned port, drop the listener. The port is only
/// a hint: another process can take it before the sidecar binds. The shell
/// therefore checks the listener's owner (see `listener::owned_by`) before it
/// sends the session token anywhere.
fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// 256 bits of OS randomness as lowercase hex.
fn new_session_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Shell lifecycle log: `shell.log` in the app-data dir, plus stderr for debug runs.
static SHELL_LOG: OnceLock<PathBuf> = OnceLock::new();

/// Create `path` and its parents for the app's own files. On unix the folder is
/// owner-only: the logs and recordings name the symbols the user subscribes to, so
/// other local accounts must not read them.
fn ensure_private_dir(path: &Path) -> io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn init_shell_log(data_dir: &Path) {
    if let Err(err) = ensure_private_dir(data_dir) {
        eprintln!("[flowmap] could not create {}: {err}", data_dir.display());
    }
    let path = data_dir.join("shell.log");
    // Set first, so a rotation that fails is reported in the log it could not move.
    let _ = SHELL_LOG.set(path.clone());
    if fs::metadata(&path)
        .map(|meta| meta.len() > SHELL_LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        rotate_to_previous(&path);
    }
}

fn shell_log(message: &str) {
    eprintln!("[flowmap] {message}");
    let Some(path) = SHELL_LOG.get() else { return };
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{} {message}", utc_timestamp(now_secs()));
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Show a message to the user on every platform, and log it.
fn alert(title: &str, message: &str) {
    shell_log(&format!("{title}: {message}"));
    show_native_dialog(title, message);
}

/// Fatal startup failure: show the message, exit non-zero. Never returns.
fn fatal(lang: Lang, message: &str) -> ! {
    alert(
        text(lang, Key::FailedTitle),
        &format!("{message}\n\n{}", text(lang, Key::ExitNotice)),
    );
    std::process::exit(1);
}

/// Release the managed sentinel, if this process holds it.
fn release_instance_lock(app: &AppHandle) {
    if let Some(state) = app.try_state::<InstanceState>() {
        if let Some(instance) = lock_or_recover(&state.0).take() {
            instance.release();
        }
    }
}

/// Whether teardown has begun (the supervisor must not respawn into it).
fn is_shutting_down(app: &AppHandle) -> bool {
    app.try_state::<ShutdownState>()
        .map(|s| s.0.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// Locate the bundled interpreter inside the resource dir (macOS:
/// `Contents/Resources/pyruntime`, Windows/Linux: the platform resource dir).
///
/// The interpreter sub-path is OS-specific: astral's python-build-standalone
/// puts the Windows interpreter at the runtime ROOT (`python.exe`, no `bin/`),
/// while the macOS/Linux interpreter lives under `bin/`. We also try a
/// `resources/pyruntime/` root so the resolver works whether the tree was
/// placed by the Tauri `resources` map (→ `<res>/pyruntime`) or the macOS
/// `ditto` injection in build-dmg.sh (→ `<res>/pyruntime`) — and a defensive
/// `resources/pyruntime` fallback covers a list-form `resources` layout.
fn resolve_python(app: &AppHandle) -> Option<PathBuf> {
    // Windows candidates FIRST on Windows; unix candidates on macOS/Linux.
    #[cfg(windows)]
    let interpreters: &[&str] = &["python.exe", "python3.13.exe"];
    #[cfg(unix)]
    let interpreters: &[&str] = &["bin/python3.13", "bin/python3"];

    for root in ["pyruntime", "resources/pyruntime"] {
        for interp in interpreters {
            let rel = format!("{root}/{interp}");
            if let Ok(p) = app.path().resolve(&rel, BaseDirectory::Resource) {
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Where the bundled interpreter is expected, for the missing-runtime dialog.
fn runtime_hint() -> &'static str {
    // `cfg!` rather than cfg-gated returns: every branch type-checks on every platform.
    if cfg!(target_os = "macos") {
        "Contents/Resources/pyruntime/bin/python3.13"
    } else if cfg!(windows) {
        "<resources>\\pyruntime\\python.exe"
    } else {
        "<resources>/pyruntime/bin/python3.13"
    }
}

/// Debug builds only: attach to a server the developer started themselves
/// (for example `python -m flowmap_server` on this port) instead of spawning one.
#[cfg(debug_assertions)]
fn dev_sidecar_port() -> Option<u16> {
    std::env::var("FLOWMAP_DEV_SIDECAR_PORT")
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(not(debug_assertions))]
fn dev_sidecar_port() -> Option<u16> {
    None
}

/// The main window may load only the app's own origin. Anything else, such as a
/// link or a redirect, is refused rather than opened in the webview that holds
/// the session token. Windows serves the app over `http://tauri.localhost`; the
/// other platforms use the `tauri://localhost` scheme.
fn is_app_origin(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => url.as_str() == "about:blank",
    }
}

/// UTC calendar stamp `YYYY-MM-DDTHH:MM:SSZ` from unix seconds (Howard
/// Hinnant's civil-from-days algorithm; no chrono dependency). Diagnostic
/// log-stamping only — never parsed back.
fn utc_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

/// Replace `path` with `bytes` via a sibling temporary file and a rename.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, path)
}

/// Initial window size: the 1440x900 design size, capped at 90% of the primary
/// monitor's work area, so the title bar stays on screen on small laptops.
fn initial_window_size(app: &AppHandle) -> (f64, f64) {
    const DESIGN: (f64, f64) = (1440.0, 900.0);
    match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor().max(1.0);
            let area = monitor.work_area().size;
            let max_w = f64::from(area.width) / scale * 0.9;
            let max_h = f64::from(area.height) / scale * 0.9;
            (DESIGN.0.min(max_w.floor()), DESIGN.1.min(max_h.floor()))
        }
        _ => DESIGN,
    }
}

/// Paths and switches the webview commands read, managed for the whole run.
struct ShellPaths {
    data_dir: PathBuf,
    /// The same switch the supervisor reads when it spawns the sidecar.
    recording: Arc<AtomicBool>,
}

/// The Settings screen's view of recording, and the result of changing it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingSettings {
    enabled: bool,
    cap_gb: f64,
    /// Where the recordings are written: the `recordings` folder in the app-data dir.
    folder: String,
    /// True when the change restarted a running sidecar, so it applies now.
    restarting: bool,
}

fn recording_settings_for(paths: &ShellPaths, restarting: bool) -> RecordingSettings {
    RecordingSettings {
        enabled: paths.recording.load(Ordering::Relaxed),
        cap_gb: RECORDING_GB_CAP,
        folder: paths.data_dir.join("recordings").display().to_string(),
        restarting,
    }
}

/// The recording switch and its size cap, for the Settings screen.
#[tauri::command]
fn recording_settings(paths: State<'_, ShellPaths>) -> RecordingSettings {
    recording_settings_for(&paths, false)
}

/// Whether a recording change restarts the sidecar at once. The supervisor restarts a
/// sidecar only while one is starting, live or restarting. A failed or external
/// sidecar keeps the saved value for its next spawn, so the window must not report a
/// restart for it.
fn restarts_sidecar_now(phase: Option<&str>) -> bool {
    matches!(phase, Some("starting" | "live" | "restarting"))
}

/// Turn recording on or off. The choice is saved first, then a running sidecar is
/// restarted so the change takes effect at once. Recording stops for the time the
/// sidecar restarts, and the window reconnects by itself.
#[tauri::command]
fn set_recording_enabled(
    enabled: bool,
    paths: State<'_, ShellPaths>,
    supervisor: State<'_, Supervisor>,
) -> Result<RecordingSettings, String> {
    write_recording_pref(&paths.data_dir, enabled).map_err(|err| err.to_string())?;
    let changed = swap_recording(&paths.recording, enabled);
    let phase = lock_or_recover(&supervisor.status)
        .get("state")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let sent = changed
        && match lock_or_recover(&supervisor.commands).as_ref() {
            Some(tx) => tx.send(SupervisorCommand::ApplySettings).is_ok(),
            None => false,
        };
    let restarting = sent && restarts_sidecar_now(phase.as_deref());
    if changed && !restarting {
        // The switch is saved and applies when a sidecar next starts. The window
        // reports `restarting: false`, so it does not claim an immediate change.
        shell_log(
            "recording switch saved; no sidecar restarts now, so it applies at its next start",
        );
    }
    Ok(recording_settings_for(&paths, restarting))
}

/// The file manager command for the platform.
fn folder_opener() -> &'static str {
    if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    }
}

/// Open the app-data folder, which holds the logs and the recordings. The file
/// manager runs detached, so a slow one never blocks the window.
#[tauri::command]
fn open_log_folder(paths: State<'_, ShellPaths>) -> Result<(), String> {
    let mut child = Command::new(folder_opener())
        .arg(&paths.data_dir)
        .spawn()
        .map_err(|err| err.to_string())?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            retry_sidecar,
            recording_settings,
            set_recording_enabled,
            open_log_folder
        ])
        .setup(|app| {
            setup_shell(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Single-window app: closing the window quits. The stop runs on its
                // own thread because it can take up to GRACEFUL_STOP, and the event
                // thread must stay responsive while it does.
                let handle = window.app_handle().clone();
                if let Some(state) = handle.try_state::<ShutdownState>() {
                    state.0.store(true, Ordering::Relaxed);
                }
                // Keep the placement for the next launch (not for the benchmark frame).
                if handle.config().identifier != BENCHMARK_IDENTIFIER {
                    if let (Some(paths), Some(placed)) = (
                        handle.try_state::<ShellPaths>(),
                        current_window_state(window),
                    ) {
                        if let Err(err) = write_window_state(&paths.data_dir, placed) {
                            shell_log(&format!("could not save the window placement: {err}"));
                        }
                    }
                }
                std::thread::spawn(move || {
                    if let Some(state) = handle.try_state::<SidecarState>() {
                        kill_sidecar(&state);
                    }
                    release_instance_lock(&handle);
                    handle.exit(0);
                });
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            // The build runs before any window exists, so a failure is shown in a
            // native dialog rather than panicking, which a GUI build would hide.
            let lang = detect_lang();
            fatal(
                lang,
                &text(lang, Key::Build).replace("{}", &err.to_string()),
            )
        })
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<ShutdownState>() {
                    state.0.store(true, Ordering::Relaxed);
                }
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
                release_instance_lock(app_handle);
            }
        });
}

/// Start the shell from the setup hook: the single-instance guard, the sidecar (or
/// the developer's own), and the main window. Every failure ends in a dialog
/// through `fatal`, because a panic in the GUI build is silent.
fn setup_shell(app: &mut tauri::App) {
    let handle = app.handle().clone();
    let lang = detect_lang();

    // Single-instance guard first: two shells would race the recorder's
    // disk-scan part numbering and corrupt each other's recordings.
    let data_dir = match app_data_directory(&handle) {
        Ok(dir) => dir,
        Err(err) => fatal(
            lang,
            &text(lang, Key::DataDir).replace("{}", &err.to_string()),
        ),
    };
    init_shell_log(&data_dir);
    shell_log(&format!("FlowMap {} starting", env!("CARGO_PKG_VERSION")));
    match acquire_instance_lock(&data_dir) {
        Ok(guard) => {
            app.manage(InstanceState(Mutex::new(Some(guard))));
        }
        Err(LockError::AlreadyRunning) => {
            if !focus_existing_window(lock_holder_pid(&data_dir)) {
                alert("FlowMap", text(lang, Key::AlreadyRunning));
            }
            std::process::exit(0);
        }
        // Fail open on unexpected filesystem errors: a broken sentinel
        // must not brick the app — log loudly instead.
        Err(LockError::Io(err)) => {
            shell_log(&format!(
                "instance lock unavailable ({err}); continuing without single-instance protection"
            ));
        }
    }

    let benchmark = handle.config().identifier == BENCHMARK_IDENTIFIER;
    app.manage(ShutdownState(AtomicBool::new(false)));
    app.manage(Supervisor::default());
    let recording = Arc::new(AtomicBool::new(read_recording_pref(&data_dir)));
    app.manage(ShellPaths {
        data_dir: data_dir.clone(),
        recording: Arc::clone(&recording),
    });

    // The origin the webview talks to, and the token that proves the webview is this
    // shell's client. Both are injected before the client JS runs.
    let (port, token) = match dev_sidecar_port() {
        Some(port) => {
            attach_developer_sidecar(&handle, port);
            (port, None)
        }
        None => {
            let (port, token) =
                start_bundled_sidecar(&handle, &data_dir, lang, benchmark, &recording);
            (port, Some(token))
        }
    };
    let mut init = format!(
        "window.__FLOWMAP_SERVER__ = \"http://127.0.0.1:{port}\"; window.__FLOWMAP_BENCHMARK__ = {benchmark};"
    );
    if let Some(token) = &token {
        init.push_str(&format!(" window.__FLOWMAP_SESSION_TOKEN__ = \"{token}\";"));
    }
    open_main_window(app, lang, benchmark, &data_dir, &init);
}

/// Debug builds: the window attaches to a server the developer started. No session
/// token is injected, and the supervisor does not manage that server.
fn attach_developer_sidecar(handle: &AppHandle, port: u16) {
    shell_log(&format!(
        "using the developer sidecar on :{port}; no session token"
    ));
    let status = serde_json::json!({
        "state": Phase::External.as_str(),
        "port": port,
        "logPath": null,
        "detail": "developer-run sidecar",
    });
    *lock_or_recover(&handle.state::<Supervisor>().status) = status;
}

/// Release path: pick the port and the session token, spawn the bundled server and
/// hand it to the supervisor. Returns the port and the token. The window only
/// receives the token once the OS confirms that the sidecar owns the port.
fn start_bundled_sidecar(
    handle: &AppHandle,
    data_dir: &Path,
    lang: Lang,
    benchmark: bool,
    recording: &Arc<AtomicBool>,
) -> (u16, String) {
    let port = match free_loopback_port() {
        Ok(port) => port,
        Err(err) => fatal(lang, &text(lang, Key::Port).replace("{}", &err.to_string())),
    };
    let token = match new_session_token() {
        Ok(token) => token,
        Err(err) => fatal(
            lang,
            &text(lang, Key::Token).replace("{}", &err.to_string()),
        ),
    };
    let python = match resolve_python(handle) {
        Some(python) => python,
        None => fatal(
            lang,
            &text(lang, Key::RuntimeMissing).replace("{}", runtime_hint()),
        ),
    };
    let launch = Launch {
        python,
        data_dir: data_dir.to_path_buf(),
        log_path: data_dir.join("flowmap-server.log"),
        port,
        token: token.clone(),
        benchmark,
        lang,
        recording: Arc::clone(recording),
    };
    let mut child = match spawn_sidecar(&launch, 0) {
        Ok(child) => child,
        Err(err) => {
            let log = text(lang, Key::LogAt).replace("{}", &launch.log_path.display().to_string());
            fatal(
                lang,
                &format!(
                    "{}\n\n{log}",
                    text(lang, Key::Spawn).replace("{}", &err.to_string())
                ),
            );
        }
    };
    // The window receives the token only once the operating system confirms that this
    // child owns the port. A process that took the port first never sees the token,
    // and the app stops with a dialog.
    if let Err(err) = listener::wait_until_owned(&mut child, port, STARTUP_HEALTH_TIMEOUT) {
        shell_log(&format!("the sidecar did not take its port: {err}"));
        stop_child(&mut child, GRACEFUL_STOP);
        let log = text(lang, Key::LogAt).replace("{}", &launch.log_path.display().to_string());
        fatal(
            lang,
            &format!(
                "{}\n\n{log}",
                text(lang, Key::NotListening).replace("{}", &err)
            ),
        );
    }
    if benchmark {
        let info = serde_json::json!({
            "identifier": BENCHMARK_IDENTIFIER, "rootPid": std::process::id(),
            "sidecarPid": child.id(), "profile": data_dir,
            "interpreter": resolve_python(handle),
            "webviewCache": data_dir.join("webview-cache"), "serverPort": port,
            "recordingEnabled": true,
        });
        if let Err(err) = fs::write(data_dir.join("native-info.json"), info.to_string()) {
            // A `?` here would end setup silently in the GUI build, so the sidecar is
            // stopped and the failure is shown instead.
            stop_child(&mut child, GRACEFUL_STOP);
            fatal(
                lang,
                &text(lang, Key::BenchmarkInfo).replace("{}", &err.to_string()),
            );
        }
    }
    handle.manage(SidecarState(Mutex::new(Some(child))));
    publish(
        handle,
        &launch,
        Phase::Starting,
        "spawned; waiting for /api/health",
    );
    let (tx, rx) = mpsc::channel();
    *lock_or_recover(&handle.state::<Supervisor>().commands) = Some(tx);
    spawn_supervisor(handle.clone(), launch, rx);
    (port, token)
}

/// The main window: the last placement when it still fits a connected monitor,
/// otherwise the default size, centred. The benchmark build keeps its fixed frame.
fn open_main_window(
    app: &mut tauri::App,
    lang: Lang,
    benchmark: bool,
    data_dir: &Path,
    init: &str,
) {
    let handle = app.handle().clone();
    let placement = if benchmark {
        None
    } else {
        read_window_state(data_dir).and_then(|saved| place_window(saved, &logical_areas(&handle)))
    };
    let (width, height) = match placement {
        Some(placed) => (placed.width, placed.height),
        None => initial_window_size(&handle),
    };
    let mut window_builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            .title("FlowMap")
            .inner_size(width, height)
            .min_inner_size(900.0, 600.0)
            // The default dark theme's background (`--bg` in client/src/theme/themes.css),
            // so the first paint is not white.
            .background_color(tauri::window::Color(8, 27, 55, 255))
            .initialization_script(init)
            .on_navigation(is_app_origin);
    window_builder = match placement {
        Some(placed) => window_builder.position(placed.x, placed.y),
        None => window_builder.center(),
    };
    if benchmark {
        window_builder = window_builder
            .title("FlowMap Benchmark")
            .inner_size(1920.0, 1080.0)
            .decorations(false)
            .resizable(false)
            .shadow(false)
            .data_directory(data_dir.join("webview-cache"));
    }
    if let Err(err) = window_builder.build() {
        // The sidecar is already running. Stop it before exiting: on macOS the stdin
        // EOF is its only orphan guard, and the process would otherwise outlive the shell.
        if let Some(state) = handle.try_state::<SidecarState>() {
            kill_sidecar(&state);
        }
        fatal(
            lang,
            &text(lang, Key::Window).replace("{}", &err.to_string()),
        );
    }
}

/// Application data dir (`%APPDATA%\<id>`, `~/Library/Application Support/<id>`,
/// `~/.local/share/<id>`), or the isolated benchmark profile for the benchmark build.
fn app_data_directory(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if app.config().identifier != BENCHMARK_IDENTIFIER {
        if std::env::var_os("FLOWMAP_BENCHMARK_PROFILE").is_some()
            || std::env::var_os("FLOWMAP_BENCHMARK_OWNER").is_some()
        {
            return Err(
                "benchmark environment requires the isolated benchmark build identity".into(),
            );
        }
        return Ok(app.path().app_data_dir()?);
    }
    let path = PathBuf::from(std::env::var("FLOWMAP_BENCHMARK_PROFILE")?);
    let token = std::env::var("FLOWMAP_BENCHMARK_OWNER")?;
    if !path.is_absolute()
        || token.len() < 16
        || std::fs::read_to_string(path.join(".flowmap-benchmark-owner"))? != token
    {
        return Err("benchmark requires an absolute owned profile and matching owner token".into());
    }
    Ok(path.canonicalize()?)
}

const BENCHMARK_IDENTIFIER: &str = "com.nazmiefearmutcu.flowmap.benchmark";

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn the_app_data_folder_is_private_to_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("flowmap-private-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        ensure_private_dir(&dir).expect("create the folder");
        let mode = fs::metadata(&dir)
            .expect("stat the folder")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700, "other local accounts must not read it");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_token_is_256_bits_of_lowercase_hex() {
        let token = new_session_token().expect("os randomness");
        assert_eq!(token.len(), 64);
        assert!(token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(token, new_session_token().expect("os randomness"));
    }

    #[test]
    fn only_the_app_origin_may_load_in_the_main_window() {
        let parse = |text: &str| tauri::Url::parse(text).expect("a valid URL");
        assert!(is_app_origin(&parse("tauri://localhost/index.html")));
        assert!(is_app_origin(&parse("http://tauri.localhost/index.html")));
        assert!(is_app_origin(&parse("about:blank")));
        assert!(!is_app_origin(&parse("https://example.com/")));
        assert!(
            !is_app_origin(&parse("http://127.0.0.1:49152/api/health")),
            "the sidecar is not a page the window may navigate to"
        );
        assert!(!is_app_origin(&parse("tauri://example.com/")));
        assert!(!is_app_origin(&parse("file:///etc/hosts")));
        assert!(!is_app_origin(&parse("javascript:alert(1)")));
    }

    #[test]
    fn the_licence_files_in_the_bundle_are_the_repository_ones() {
        // The installers ship these copies (tauri.conf.json bundle.resources), so
        // they must not drift from the files the release describes.
        assert_eq!(
            include_bytes!("../resources/LICENSE")[..],
            include_bytes!("../../../LICENSE")[..]
        );
        assert_eq!(
            include_bytes!("../resources/NOTICE")[..],
            include_bytes!("../../../NOTICE")[..]
        );
    }

    #[test]
    fn a_settings_change_reports_a_restart_only_where_the_supervisor_restarts() {
        for phase in ["starting", "live", "restarting"] {
            assert!(restarts_sidecar_now(Some(phase)), "{phase} restarts");
        }
        for phase in ["failed", "external"] {
            assert!(!restarts_sidecar_now(Some(phase)), "{phase} does not");
        }
        assert!(!restarts_sidecar_now(None), "no status yet");
    }

    #[test]
    fn utc_timestamp_matches_known_epochs() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(utc_timestamp(1_752_710_400), "2025-07-17T00:00:00Z");
        assert_eq!(utc_timestamp(4_102_444_800), "2100-01-01T00:00:00Z"); // post-2038 sanity
    }
}
