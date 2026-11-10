"""Smoke-test an installed Linux or macOS FlowMap build: install, launch, health, close.

Run by release.yml on the Linux and macOS legs, against the installers that leg
built. The Windows legs use scripts/packaged_smoke_windows.py; this file runs the
same checks for the other installers:

  .deb       installed with apt-get; the `flowmap` binary is found on PATH
  .AppImage  run in place (APPIMAGE_EXTRACT_AND_RUN=1, the runner has no FUSE)
  .dmg       attached read-only, FlowMap.app copied out with ditto, then detached

Then, for the launched shell:

1. read the sidecar port from shell.log in the per-user app-data directory;
2. require GET /api/health to answer 200 with status ok (the server is live);
3. require the loopback guards: a foreign Host header is refused with 400, and a
   request without the session token gets 401;
4. close the shell with SIGTERM and require it to exit;
5. require that no flowmap_server python process is left running;
6. remove what the install put on the machine.

The Linux legs wrap this script in xvfb-run, because the shell opens a window.
Any failed check exits non-zero. The pure helpers are importable on any OS, so
scripts/test_packaged_smoke_posix.py runs in the Linux release-tooling job.
"""

import argparse
import http.client
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile

from packaged_smoke_windows import (
    SmokeError,
    is_healthy,
    read_new_text,
    request,
    sidecar_port,
    wait_until,
)


APP_ID = "com.nazmiefearmutcu.flowmap"
BINARY_NAME = "flowmap"
SIDECAR_MARKER = "flowmap_server"
PLATFORM_OF_SUFFIX = {".deb": "linux", ".appimage": "linux", ".dmg": "darwin"}


def platform_for(installer):
    """The OS an installer belongs to, from its file name; None when unknown."""
    return PLATFORM_OF_SUFFIX.get(installer.suffix.lower())


def app_data_dir(platform, environ, home):
    """Where the shell keeps shell.log: Tauri's app-data directory for the identifier."""
    if platform == "darwin":
        return Path(home) / "Library" / "Application Support" / APP_ID
    data_home = environ.get("XDG_DATA_HOME") or str(Path(home) / ".local" / "share")
    return Path(data_home) / APP_ID


def leftover_sidecars(ps_listing):
    """PIDs of sidecar servers in an `ps -axo pid=,args=` listing."""
    pids = []
    for line in ps_listing.splitlines():
        pid, _, args = line.strip().partition(" ")
        if pid.isdigit() and SIDECAR_MARKER in args:
            pids.append(int(pid))
    return pids


def find_executable_in(directory):
    """The one file in a macOS bundle's Contents/MacOS, which is the shell binary."""
    candidates = sorted(path for path in directory.iterdir() if path.is_file())
    if not candidates:
        raise SmokeError(f"no executable in {directory}")
    for candidate in candidates:
        if candidate.name == BINARY_NAME:
            return candidate
    return candidates[0]


def run_checked(command, timeout):
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if completed.returncode != 0:
        raise SmokeError(f"{command[0]} exited with {completed.returncode}: {completed.stderr.strip()}")
    return completed


def list_processes():
    completed = subprocess.run(["ps", "-axo", "pid=,args="], capture_output=True, text=True, timeout=60)
    return completed.stdout


class Install:
    """What one installer put on the machine, and how to take it off again."""

    def __init__(self, executable, cleanup):
        self.executable = executable
        self.cleanup = cleanup


def deb_package_name(control_field_output):
    """The package name from `dpkg-deb -f <deb> Package` output; a SmokeError when empty."""
    name = control_field_output.strip()
    if not name or any(ch.isspace() for ch in name):
        raise SmokeError(f"the .deb does not name its package: {control_field_output!r}")
    return name


def install_deb(installer, timeout, scratch):
    # The package is named by the bundler (from the product name), not after the
    # binary, so the uninstall reads the name from the .deb it installed.
    package = deb_package_name(run_checked(["dpkg-deb", "-f", str(installer), "Package"], timeout).stdout)
    run_checked(["sudo", "apt-get", "install", "-y", "--no-install-recommends", str(installer)], timeout)
    found = shutil.which(BINARY_NAME)
    if found is None:
        raise SmokeError(f"the {BINARY_NAME} binary is not on PATH after the .deb install")
    return Install(Path(found), lambda: run_checked(["sudo", "apt-get", "remove", "-y", package], timeout))


def install_appimage(installer, timeout, scratch):
    # An AppImage is its own installation: it runs where it was built, and the
    # leg removes nothing because it installed nothing.
    installer.chmod(installer.stat().st_mode | 0o755)
    return Install(installer, lambda: None)


def install_dmg(installer, timeout, scratch):
    mount = scratch / "mount"
    mount.mkdir()
    run_checked(["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify",
                 "-mountpoint", str(mount), str(installer)], timeout)
    try:
        bundle = scratch / "FlowMap.app"
        run_checked(["ditto", str(mount / "FlowMap.app"), str(bundle)], timeout)
    finally:
        subprocess.run(["hdiutil", "detach", str(mount)], capture_output=True, text=True, timeout=timeout)
    executable = find_executable_in(bundle / "Contents" / "MacOS")
    return Install(executable, lambda: shutil.rmtree(bundle, ignore_errors=True))


def install(installer, timeout, scratch):
    suffix = installer.suffix.lower()
    if suffix == ".deb":
        return install_deb(installer, timeout, scratch)
    if suffix == ".appimage":
        return install_appimage(installer, timeout, scratch)
    if suffix == ".dmg":
        return install_dmg(installer, timeout, scratch)
    raise SmokeError(f"no installer handling for {installer.name}")


def shell_children(ps_listing, launcher_pid):
    """PIDs of the shell processes started by a launcher, from `ps -axo pid=,ppid=,args=`.

    An AppImage is launched through its runtime, which extracts the image and runs
    the shell as its child. The runtime does not pass SIGTERM on, so the signal has
    to go to that child. The sidecar server is also a child of the shell itself and
    is never a target: the shell must stop it.
    """
    rows = []
    for line in ps_listing.splitlines():
        fields = line.split(None, 2)
        if len(fields) == 3 and fields[0].isdigit() and fields[1].isdigit():
            rows.append((int(fields[0]), int(fields[1]), fields[2]))
    # Every descendant of the launcher: the runtime may run the shell through AppRun.
    family = {launcher_pid}
    grew = True
    while grew:
        grew = False
        for pid, parent, _ in rows:
            if parent in family and pid not in family:
                family.add(pid)
                grew = True
    # Only the shell binary: a directly launched shell has the sidecar and the web
    # view helpers below it, and none of those is a signal target.
    return sorted(
        pid for pid, _, args in rows
        if pid in family and pid != launcher_pid and SIDECAR_MARKER not in args
        and Path(args.split()[0]).name == BINARY_NAME
    )


def list_process_tree():
    completed = subprocess.run(["ps", "-axo", "pid=,ppid=,args="], capture_output=True, text=True, timeout=60)
    return completed.stdout


def stop_shell(process):
    """Close the shell the way a user does (SIGTERM) and require it to exit."""
    if process.poll() is not None:
        return
    children = shell_children(list_process_tree(), process.pid)
    if children:
        # Launched through a wrapper (the AppImage runtime): signal the shell it runs.
        for pid in children:
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    else:
        process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()
        raise SmokeError("the shell did not exit after SIGTERM; it was killed")


def check_shell(process, shell_log, offset, timeout):
    """The launched shell must start a server that answers, guards and then exits."""
    port = None

    def port_known():
        nonlocal port
        port = sidecar_port(read_new_text(shell_log, offset))
        return port is not None

    if not wait_until(port_known, timeout):
        raise SmokeError(f"the shell did not start a sidecar; see {shell_log}")

    def healthy():
        # A server that is still starting refuses, resets or half-answers the probe.
        try:
            return is_healthy(*request(port, "/api/health"))
        except (OSError, http.client.HTTPException):
            return False

    if not wait_until(healthy, timeout):
        raise SmokeError(f"GET /api/health on port {port} never answered 200 ok")

    status, _ = request(port, "/api/health", host="rebinding.example")
    if status != 400:
        raise SmokeError(f"a foreign Host header got {status}, expected 400")
    status, _ = request(port, "/api/symbols")
    if status != 401:
        raise SmokeError(f"a request without the session token got {status}, expected 401")


def scratch_dir():
    """A fresh working folder whose path contains no symlink.

    The shell refuses to resolve its own location when an ancestor of the
    executable is a symlink (Tauri's guard on macOS), and it then cannot find the
    bundled runtime. macOS temp folders live under /var, a symlink to /private/var,
    so the path is resolved before anything is copied into it.
    """
    return Path(tempfile.mkdtemp(prefix="flowmap-smoke-")).resolve()


def smoke(installer, timeout):
    shell_log = app_data_dir(platform_for(installer), os.environ, Path.home()) / "shell.log"
    scratch = scratch_dir()
    staged = None
    failed = False
    try:
        staged = install(installer, timeout, scratch)
        offset = shell_log.stat().st_size if shell_log.is_file() else 0
        process = subprocess.Popen([str(staged.executable)],
                                   env=dict(os.environ, APPIMAGE_EXTRACT_AND_RUN="1"),
                                   start_new_session=True)
        try:
            check_shell(process, shell_log, offset, timeout)
        finally:
            stop_shell(process)
        if not wait_until(lambda: not leftover_sidecars(list_processes()), 30):
            raise SmokeError(f"sidecar processes survived the shell: {leftover_sidecars(list_processes())}")
    except BaseException:
        failed = True
        raise
    finally:
        try:
            if staged is not None:
                staged.cleanup()
        except SmokeError as error:
            # A failed uninstall must not replace the check that failed first.
            if not failed:
                raise
            print(f"packaged_smoke_posix: cleanup also failed: {error}", file=sys.stderr)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--installer", type=Path, required=True,
                        help="the .deb, .AppImage or .dmg built by this leg")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="seconds allowed for each wait (install, health, exit)")
    args = parser.parse_args(argv)
    args.installer = args.installer.resolve()
    platform = platform_for(args.installer)
    if platform is None:
        print(f"packaged_smoke_posix: no smoke for {args.installer.name}", file=sys.stderr)
        return 2
    if sys.platform != platform:
        print(f"packaged_smoke_posix: {args.installer.name} needs {platform}, running on {sys.platform}",
              file=sys.stderr)
        return 2
    if not args.installer.is_file():
        print(f"packaged_smoke_posix: no installer at {args.installer}", file=sys.stderr)
        return 1
    try:
        smoke(args.installer, args.timeout)
    except (SmokeError, OSError, subprocess.SubprocessError) as error:
        print(f"packaged_smoke_posix: FAILED for {args.installer.name}: {error}", file=sys.stderr)
        return 1
    print(f"packaged_smoke_posix: passed for {args.installer.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
