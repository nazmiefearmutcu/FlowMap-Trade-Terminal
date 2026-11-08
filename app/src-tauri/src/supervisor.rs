//! Supervision of the sidecar for the rest of the app run: the health probe, the
//! restart policy with its backoff and budget, the phases published to the
//! webview, and the commands the webview can send to restart the sidecar.

use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::dialog_text::{text, Key};
use crate::listener;
use crate::sidecar::{
    check_child, child_recording, health_ok, kill_sidecar, spawn_sidecar, stop_child, ChildCheck,
    Launch, ManagedChild, SidecarState, GRACEFUL_STOP,
};
use crate::{alert, is_shutting_down, lock_or_recover, shell_log};

/// How often the supervisor checks a running sidecar.
const MONITOR_INTERVAL: Duration = Duration::from_secs(10);
/// How often the supervisor checks a sidecar that has not answered yet.
const STARTING_POLL: Duration = Duration::from_secs(1);
/// A freshly started sidecar gets this long to answer /api/health.
pub(crate) const STARTUP_HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Consecutive failed probes after the sidecar was live before it is restarted.
const HEALTH_FAILURES_BEFORE_RESTART: u32 = 3;
/// A sidecar healthy for this long refunds the restart budget.
const STABLE_AFTER_RESTART: Duration = Duration::from_secs(60);
/// Restarts allowed before the shell stops and reports the failure.
const MAX_RESTART_ATTEMPTS: u32 = 5;
/// Longest wait between two restart attempts.
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// Webview event carrying sidecar phase changes.
const STATUS_EVENT: &str = "sidecar-status";

/// Commands the webview can send to the supervisor. An accepted command respawns
/// the sidecar at once (see `command_restarts`). Only `Retry` restores the full
/// restart budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SupervisorCommand {
    /// The window's Retry action.
    Retry,
    /// A Settings change that only takes effect in a new sidecar (recording switch).
    ApplySettings,
}

impl SupervisorCommand {
    fn reason(self) -> &'static str {
        match self {
            SupervisorCommand::Retry => "retry requested from the window",
            SupervisorCommand::ApplySettings => {
                "settings changed in the window; restarting the sidecar"
            }
        }
    }
}

/// Whether a command from the webview restarts the sidecar now. Pure, so the rules are
/// unit-tested without processes.
///
/// A `Retry` is honoured only while the window can show it: the sidecar has failed, or
/// is live. One that arrives during a restart is dropped, so it cannot refund the
/// budget of the restart in progress. An `ApplySettings` restarts only a sidecar that
/// was spawned with the other recording switch. A sidecar spawned after the change
/// already reads the new value, and a queued duplicate then finds nothing to change.
fn command_restarts(
    command: SupervisorCommand,
    phase: Phase,
    switch: bool,
    child_recording: Option<bool>,
) -> bool {
    match command {
        SupervisorCommand::Retry => matches!(phase, Phase::Failed | Phase::Live),
        SupervisorCommand::ApplySettings => {
            child_recording.is_some_and(|spawned| spawned != switch)
        }
    }
}

/// Managed handle for the sidecar status commands: the latest published status
/// (so a window that opens late can still read it) and the supervisor's inbox.
#[derive(Default)]
pub(crate) struct Supervisor {
    pub(crate) commands: Mutex<Option<mpsc::Sender<SupervisorCommand>>>,
    pub(crate) status: Mutex<serde_json::Value>,
}

/// Phases published to the webview as `sidecar-status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Phase {
    Starting,
    Live,
    Restarting,
    Failed,
    External,
}

impl Phase {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Phase::Starting => "starting",
            Phase::Live => "live",
            Phase::Restarting => "restarting",
            Phase::Failed => "failed",
            Phase::External => "external",
        }
    }
}

/// Restart policy for the sidecar. Pure (time is passed in), so the backoff,
/// the probe threshold and the budget refund are unit-tested without processes.
#[derive(Debug, Default)]
struct RestartPolicy {
    restarts: u32,
    failed_probes: u32,
    healthy_since: Option<Instant>,
}

impl RestartPolicy {
    fn record_healthy(&mut self, now: Instant) {
        self.failed_probes = 0;
        let since = *self.healthy_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= STABLE_AFTER_RESTART {
            self.restarts = 0;
        }
    }

    fn record_unhealthy(&mut self) {
        self.failed_probes += 1;
        self.healthy_since = None;
    }

    fn probes_exhausted(&self) -> bool {
        self.failed_probes >= HEALTH_FAILURES_BEFORE_RESTART
    }

    /// Backoff before the next restart attempt, or None when the budget is spent.
    fn next_backoff(&mut self) -> Option<Duration> {
        if self.restarts >= MAX_RESTART_ATTEMPTS {
            return None;
        }
        self.restarts += 1;
        Some(backoff_for(self.restarts))
    }

    /// Probe bookkeeping for a freshly spawned child (the budget is kept).
    fn reset_for_new_child(&mut self) {
        self.failed_probes = 0;
        self.healthy_since = None;
    }

    /// A manual retry starts with a full budget.
    fn reset_budget(&mut self) {
        *self = Self::default();
    }
}

/// 1 s, 2 s, 4 s, ... capped at `MAX_BACKOFF`, for restart attempt `attempt` (1-based).
fn backoff_for(attempt: u32) -> Duration {
    let secs = 1u64 << attempt.saturating_sub(1).min(10);
    Duration::from_secs(secs).min(MAX_BACKOFF)
}

/// Sleep for `total`, returning false early when teardown begins.
fn sleep_unless_shutdown(app: &AppHandle, total: Duration) -> bool {
    let deadline = Instant::now() + total;
    loop {
        if is_shutting_down(app) {
            return false;
        }
        let now = Instant::now();
        if now >= deadline {
            return true;
        }
        std::thread::sleep((deadline - now).min(Duration::from_millis(200)));
    }
}

/// Spawn a replacement sidecar, waiting out the backoff and retrying failed
/// spawns until the budget runs out. `immediate` skips the first wait (manual
/// retry). Returns None when the budget is spent or teardown began. The wait,
/// the teardown check and the spawn are passed in, so the schedule is testable
/// without processes: `wait` returns false when teardown interrupts it.
fn respawn_with_backoff<T>(
    policy: &mut RestartPolicy,
    spawns: &mut u32,
    immediate: bool,
    mut wait: impl FnMut(Duration) -> bool,
    shutting_down: impl Fn() -> bool,
    mut spawn: impl FnMut(u32) -> Result<T, String>,
) -> Option<T> {
    let mut delay = if immediate {
        Duration::ZERO
    } else {
        policy.next_backoff()?
    };
    loop {
        if !delay.is_zero() && !wait(delay) {
            return None;
        }
        if shutting_down() {
            return None;
        }
        *spawns += 1;
        match spawn(*spawns) {
            Ok(child) => return Some(child),
            Err(_) => delay = policy.next_backoff()?,
        }
    }
}

/// Checks that a freshly spawned sidecar owns `port` before the webview's token is
/// used with it. While the sidecar was down its port was free, so another local
/// process may hold it now. A child that does not own the port is stopped and the
/// spawn counts as failed, so no token is sent to a foreign listener.
fn confirm_port_owner(
    mut child: ManagedChild,
    port: u16,
    timeout: Duration,
) -> Result<ManagedChild, String> {
    match listener::wait_until_owned(&mut child, port, timeout) {
        Ok(()) => Ok(child),
        Err(err) => {
            stop_child(&mut child, GRACEFUL_STOP);
            Err(err)
        }
    }
}

/// Publish a phase change: log it, keep it for `sidecar_status`, emit it to the
/// webview, and show a dialog when the shell gives up.
pub(crate) fn publish(app: &AppHandle, launch: &Launch, phase: Phase, detail: &str) {
    shell_log(&format!("sidecar {}: {detail}", phase.as_str()));
    let log_path = launch.log_path.display().to_string();
    let payload = serde_json::json!({
        "state": phase.as_str(),
        "port": launch.port,
        "logPath": log_path,
        "detail": detail,
    });
    if let Some(supervisor) = app.try_state::<Supervisor>() {
        *lock_or_recover(&supervisor.status) = payload.clone();
    }
    if let Err(err) = app.emit(STATUS_EVENT, payload) {
        shell_log(&format!("could not emit the sidecar status: {err}"));
    }
    if phase == Phase::Failed {
        alert(
            "FlowMap",
            &text(launch.lang, Key::ServerGaveUp).replace("{}", &log_path),
        );
    }
}

/// What the supervisor saw on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Observation {
    /// No child is in the sidecar slot.
    Missing,
    /// The child exited (and has been reaped).
    Exited,
    /// The child is running; `healthy` is the result of the /api/health probe.
    Running { healthy: bool },
}

/// The supervision rules for one tick, without processes or windows: updates the
/// restart policy and the phase, and returns why the sidecar must be replaced, if
/// it must. Pure, so the state transitions are unit-tested.
fn supervise_tick(
    policy: &mut RestartPolicy,
    phase: &mut Phase,
    starting_for: Duration,
    now: Instant,
    observation: Observation,
) -> Option<&'static str> {
    match observation {
        Observation::Missing => Some("no sidecar process"),
        Observation::Exited => Some("exited unexpectedly"),
        Observation::Running { healthy: true } => {
            policy.record_healthy(now);
            *phase = Phase::Live;
            None
        }
        Observation::Running { healthy: false } => {
            policy.record_unhealthy();
            let stalled = match *phase {
                Phase::Live => policy.probes_exhausted(),
                _ => starting_for >= STARTUP_HEALTH_TIMEOUT,
            };
            stalled.then_some("not answering /api/health")
        }
    }
}

/// Watch the sidecar for the rest of the app run. Each tick it restarts the
/// sidecar when it exited, or when it stops answering /api/health (3 failed
/// probes once live; 30 s without an answer while starting). Restarts use
/// exponential backoff and a bounded budget; every phase change is published.
/// A `Retry` from the webview resets the budget and respawns at once; an
/// `ApplySettings` respawns at once when the running sidecar predates the change.
pub(crate) fn spawn_supervisor(
    app: AppHandle,
    launch: Launch,
    commands: mpsc::Receiver<SupervisorCommand>,
) {
    std::thread::spawn(move || {
        let mut policy = RestartPolicy::default();
        let mut phase = Phase::Starting;
        let mut started = Instant::now();
        let mut spawns: u32 = 0; // spawn 0 was the launch in setup
        loop {
            let poll = if phase == Phase::Starting {
                STARTING_POLL
            } else {
                MONITOR_INTERVAL
            };
            let command = match commands.recv_timeout(poll) {
                Ok(command) => Some(command),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            };
            let retry = command.is_some();
            if is_shutting_down(&app) {
                return;
            }
            let Some(state) = app.try_state::<SidecarState>() else {
                return;
            };
            if phase == Phase::Failed && !retry {
                continue;
            }

            let reason: Option<&'static str> = if let Some(command) = command {
                let switch = launch.recording.load(Ordering::Relaxed);
                if !command_restarts(command, phase, switch, child_recording(&state)) {
                    shell_log(&format!(
                        "ignored: {} (sidecar {})",
                        command.reason(),
                        phase.as_str()
                    ));
                    continue;
                }
                if command == SupervisorCommand::Retry {
                    policy.reset_budget();
                }
                Some(command.reason())
            } else {
                let observation = match check_child(&state) {
                    ChildCheck::Exited => Observation::Exited,
                    ChildCheck::Missing => Observation::Missing,
                    ChildCheck::Running(pid) => Observation::Running {
                        // The token is sent only to the process this shell started.
                        healthy: listener::owned_by(launch.port, pid)
                            && health_ok(launch.port, &launch.token),
                    },
                };
                let before = phase;
                let reason = supervise_tick(
                    &mut policy,
                    &mut phase,
                    started.elapsed(),
                    Instant::now(),
                    observation,
                );
                if phase == Phase::Live && before != Phase::Live {
                    publish(&app, &launch, phase, "healthy on /api/health");
                }
                reason
            };
            let Some(reason) = reason else {
                continue;
            };

            kill_sidecar(&state);
            if is_shutting_down(&app) {
                return;
            }
            phase = Phase::Restarting;
            publish(&app, &launch, phase, reason);
            policy.reset_for_new_child();
            let respawned = respawn_with_backoff(
                &mut policy,
                &mut spawns,
                retry,
                |delay| sleep_unless_shutdown(&app, delay),
                || is_shutting_down(&app),
                |n| {
                    let child = spawn_sidecar(&launch, n).map_err(|err| {
                        shell_log(&format!("sidecar respawn failed: {err}"));
                        err.to_string()
                    })?;
                    confirm_port_owner(child, launch.port, STARTUP_HEALTH_TIMEOUT).map_err(|err| {
                        shell_log(&format!("sidecar respawn did not take its port: {err}"));
                        err
                    })
                },
            );
            match respawned {
                Some(child) => {
                    if is_shutting_down(&app) {
                        let mut child = child;
                        stop_child(&mut child, GRACEFUL_STOP);
                        return;
                    }
                    *lock_or_recover(&state.0) = Some(child);
                    started = Instant::now();
                    phase = Phase::Starting;
                    publish(&app, &launch, phase, "respawned; waiting for /api/health");
                }
                None => {
                    if is_shutting_down(&app) {
                        return;
                    }
                    phase = Phase::Failed;
                    publish(&app, &launch, phase, "restart budget spent");
                }
            }
        }
    });
}

/// The latest sidecar status, for a window that opened after the event fired.
#[tauri::command]
pub(crate) fn sidecar_status(supervisor: State<'_, Supervisor>) -> serde_json::Value {
    lock_or_recover(&supervisor.status).clone()
}

/// Ask the supervisor to restart the sidecar now (the window's Retry action).
#[tauri::command]
pub(crate) fn retry_sidecar(supervisor: State<'_, Supervisor>) -> Result<(), String> {
    match lock_or_recover(&supervisor.commands).as_ref() {
        Some(tx) => tx
            .send(SupervisorCommand::Retry)
            .map_err(|err| err.to_string()),
        None => Err("no sidecar is supervised in this run".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_respawned_child_that_does_not_own_the_port_is_refused() {
        // Another process holds the port (this test process), so the child spawned
        // here never owns it and must be refused rather than trusted with the token.
        let holder = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a loopback port");
        let port = holder.local_addr().expect("local address").port();
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            use windows::Win32::System::Threading::CREATE_NO_WINDOW;
            let mut command = std::process::Command::new("powershell.exe");
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
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "cat > /dev/null"]);
            command
        };
        let child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("test child");
        let child = ManagedChild::new(child, false).expect("manage the test child");
        let result = confirm_port_owner(child, port, Duration::from_millis(300));
        assert!(
            result.is_err(),
            "a child that does not own the port must not be used"
        );
        drop(holder);
    }

    #[test]
    fn restart_policy_backs_off_exponentially_then_gives_up() {
        let mut policy = RestartPolicy::default();
        let delays: Vec<u64> = (0..MAX_RESTART_ATTEMPTS)
            .map(|_| policy.next_backoff().expect("budget left").as_secs())
            .collect();
        assert_eq!(delays, [1, 2, 4, 8, 16]);
        assert!(policy.next_backoff().is_none(), "budget must be spent");
    }

    #[test]
    fn a_stable_sidecar_refunds_the_restart_budget() {
        let t0 = Instant::now();
        let mut policy = RestartPolicy::default();
        policy.next_backoff();
        policy.next_backoff();
        policy.record_healthy(t0);
        policy.record_healthy(t0 + Duration::from_secs(10));
        assert_eq!(
            policy.next_backoff(),
            Some(Duration::from_secs(4)),
            "short health does not refund"
        );
        policy.record_healthy(t0 + Duration::from_secs(61));
        assert_eq!(
            policy.next_backoff(),
            Some(Duration::from_secs(1)),
            "60 s of health refunds"
        );
    }

    #[test]
    fn restart_needs_three_consecutive_failed_probes() {
        let mut policy = RestartPolicy::default();
        policy.record_unhealthy();
        policy.record_unhealthy();
        assert!(!policy.probes_exhausted());
        policy.record_unhealthy();
        assert!(policy.probes_exhausted());
        policy.record_healthy(Instant::now());
        assert!(
            !policy.probes_exhausted(),
            "a healthy probe resets the count"
        );
    }

    #[test]
    fn a_retry_request_restores_a_full_budget() {
        let mut policy = RestartPolicy::default();
        while policy.next_backoff().is_some() {}
        policy.reset_budget();
        assert_eq!(policy.next_backoff(), Some(Duration::from_secs(1)));
    }

    #[test]
    fn a_retry_is_honoured_only_when_the_window_can_show_it() {
        for phase in [Phase::Failed, Phase::Live] {
            assert!(command_restarts(
                SupervisorCommand::Retry,
                phase,
                true,
                Some(true)
            ));
        }
        // A Retry queued behind a restart must not refund that restart's budget.
        for phase in [Phase::Starting, Phase::Restarting, Phase::External] {
            assert!(!command_restarts(
                SupervisorCommand::Retry,
                phase,
                true,
                Some(true)
            ));
        }
    }

    #[test]
    fn a_settings_change_restarts_only_a_sidecar_spawned_with_the_other_value() {
        // The switch is now off and the live child was spawned with it on: restart.
        assert!(command_restarts(
            SupervisorCommand::ApplySettings,
            Phase::Live,
            false,
            Some(true)
        ));
        // A child spawned after the change already runs with the new value.
        assert!(!command_restarts(
            SupervisorCommand::ApplySettings,
            Phase::Starting,
            false,
            Some(false)
        ));
        // No child in the slot: the next spawn reads the switch, so nothing to restart.
        assert!(!command_restarts(
            SupervisorCommand::ApplySettings,
            Phase::Failed,
            false,
            None
        ));
    }

    #[test]
    fn queued_settings_changes_cost_at_most_one_restart() {
        // The switch goes on, off and on again while a restart is under way, so three
        // commands are queued. The child spawned before them was started with off, and
        // the restart it causes spawns with the final value (on). Only the first command
        // restarts; the two that follow find the child already on the current value.
        let final_switch = true;
        let mut child_recording = Some(false);
        let mut restarts = 0;
        for _ in 0..3 {
            if command_restarts(
                SupervisorCommand::ApplySettings,
                Phase::Live,
                final_switch,
                child_recording,
            ) {
                restarts += 1;
                child_recording = Some(final_switch);
            }
        }
        assert_eq!(restarts, 1);
    }

    #[test]
    fn respawn_retries_failed_spawns_on_the_backoff_schedule() {
        let mut policy = RestartPolicy::default();
        let mut spawns = 0;
        let mut waits = Vec::new();
        let child = respawn_with_backoff(
            &mut policy,
            &mut spawns,
            false,
            |delay| {
                waits.push(delay.as_secs());
                true
            },
            || false,
            |n| {
                if n < 3 {
                    Err(format!("spawn {n} failed"))
                } else {
                    Ok(n)
                }
            },
        );
        assert_eq!(child, Some(3));
        assert_eq!(waits, [1, 2, 4]);
        assert_eq!(spawns, 3);
    }

    #[test]
    fn respawn_gives_up_when_the_budget_is_spent() {
        let mut policy = RestartPolicy::default();
        let mut spawns = 0;
        let mut waits = Vec::new();
        let child: Option<()> = respawn_with_backoff(
            &mut policy,
            &mut spawns,
            false,
            |delay| {
                waits.push(delay.as_secs());
                true
            },
            || false,
            |_| Err("always fails".to_string()),
        );
        assert!(child.is_none());
        assert_eq!(spawns, MAX_RESTART_ATTEMPTS);
        assert_eq!(waits, [1, 2, 4, 8, 16]);
    }

    #[test]
    fn teardown_during_the_wait_never_spawns() {
        let mut policy = RestartPolicy::default();
        let mut spawns = 0;
        let child: Option<()> = respawn_with_backoff(
            &mut policy,
            &mut spawns,
            false,
            |_| false,
            || false,
            |_| panic!("no spawn may start during teardown"),
        );
        assert!(child.is_none());
        assert_eq!(spawns, 0);
    }

    #[test]
    fn a_sidecar_that_never_answers_is_restarted_after_the_startup_timeout() {
        let now = Instant::now();
        let mut policy = RestartPolicy::default();
        let mut phase = Phase::Starting;
        let silent = Observation::Running { healthy: false };
        assert_eq!(
            supervise_tick(
                &mut policy,
                &mut phase,
                Duration::from_secs(29),
                now,
                silent
            ),
            None
        );
        assert_eq!(
            supervise_tick(&mut policy, &mut phase, STARTUP_HEALTH_TIMEOUT, now, silent),
            Some("not answering /api/health")
        );
        assert_eq!(phase, Phase::Starting);
    }

    #[test]
    fn a_live_sidecar_goes_live_then_restarts_after_three_failed_probes() {
        let now = Instant::now();
        let mut policy = RestartPolicy::default();
        let mut phase = Phase::Starting;
        let silent = Observation::Running { healthy: false };
        let healthy = Observation::Running { healthy: true };
        assert_eq!(
            supervise_tick(
                &mut policy,
                &mut phase,
                Duration::from_secs(2),
                now,
                healthy
            ),
            None
        );
        assert_eq!(phase, Phase::Live);
        assert_eq!(
            supervise_tick(
                &mut policy,
                &mut phase,
                Duration::from_secs(12),
                now,
                silent
            ),
            None
        );
        assert_eq!(
            supervise_tick(
                &mut policy,
                &mut phase,
                Duration::from_secs(22),
                now,
                silent
            ),
            None
        );
        assert_eq!(
            supervise_tick(
                &mut policy,
                &mut phase,
                Duration::from_secs(32),
                now,
                silent
            ),
            Some("not answering /api/health")
        );
    }

    #[test]
    fn repeated_crashes_restart_each_time_until_the_budget_runs_out() {
        // A fake child goes live, crashes, is restarted on the backoff schedule,
        // goes live again, and so on. After MAX_RESTART_ATTEMPTS restarts the budget
        // is spent, and the caller must then report failure instead of restarting.
        let now = Instant::now();
        let mut policy = RestartPolicy::default();
        let mut phase = Phase::Starting;
        let mut delays = Vec::new();
        for _ in 0..MAX_RESTART_ATTEMPTS {
            let up = Observation::Running { healthy: true };
            assert_eq!(
                supervise_tick(&mut policy, &mut phase, Duration::ZERO, now, up),
                None
            );
            assert_eq!(phase, Phase::Live);
            assert_eq!(
                supervise_tick(
                    &mut policy,
                    &mut phase,
                    Duration::ZERO,
                    now,
                    Observation::Exited
                ),
                Some("exited unexpectedly")
            );
            delays.push(policy.next_backoff().expect("budget left").as_secs());
            policy.reset_for_new_child();
            phase = Phase::Starting;
        }
        assert_eq!(delays, [1, 2, 4, 8, 16]);
        assert!(
            policy.next_backoff().is_none(),
            "the budget is spent: report failure"
        );
    }
}
