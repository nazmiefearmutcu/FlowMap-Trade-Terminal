"""Smoke-test an installed Windows FlowMap build: install, launch, health, close.

Run by release.yml on each Windows leg, against the installer that leg built:

1. install it silently (MSI with msiexec, NSIS with /S);
2. launch the installed flowmap.exe and read the sidecar port from shell.log;
3. require GET /api/health to answer 200 with status ok (the server is live);
4. require the loopback guards of the packaged server: a foreign Host header is
   refused with 400, and a request without the session token gets 401;
5. close the window the way a user does (WM_CLOSE through taskkill, no /F) and
   require the shell to exit;
6. require that no python process from the installed runtime is left running;
7. uninstall, so the next installer starts from a clean machine.

Any failed check exits non-zero. Only the pure helpers are importable on any OS,
so scripts/test_packaged_smoke_windows.py runs in the Linux release-tooling job.
"""

import argparse
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time


APP_ID = "com.nazmiefearmutcu.flowmap"
EXE_NAME = "flowmap.exe"
SIDECAR_LINE = re.compile(r"starting sidecar .* on :(\d+) \(spawn (\d+)\)")
SUCCESS_CODES = (0, 3010)  # 3010: installed, a restart was requested (/norestart)


class SmokeError(RuntimeError):
    pass


def sidecar_port(shell_log_text):
    """The port of the first sidecar this run started, or None before it starts."""
    for port, spawn in SIDECAR_LINE.findall(shell_log_text):
        if spawn == "0":
            return int(port)
    return None


def is_healthy(status, body):
    """True for the /api/health answer the shell itself accepts."""
    return status == 200 and '"status":"ok"' in body.replace(" ", "")


def install_roots(environ):
    """Where the MSI (Program Files) and the per-user NSIS installer put FlowMap."""
    roots = []
    if environ.get("PROGRAMFILES"):
        roots.append(Path(environ["PROGRAMFILES"]) / "FlowMap")
    if environ.get("LOCALAPPDATA"):
        local = Path(environ["LOCALAPPDATA"])
        roots += [local / "FlowMap", local / "Programs" / "FlowMap"]
    return roots


def find_install_root(roots, exists=lambda path: path.is_file()):
    for root in roots:
        if exists(root / EXE_NAME):
            return root
    raise SmokeError(
        f"{EXE_NAME} was not found after the install; searched: "
        + ", ".join(str(root) for root in roots)
    )


def _windows_path(value):
    """Case-folded and backslashed, so the comparison is the same on every OS."""
    return str(value).replace("/", "\\").rstrip("\\").casefold()


def leftover_sidecars(processes, install_root):
    """Processes whose executable lives under the installed runtime folder."""
    prefix = _windows_path(install_root) + "\\"
    return [
        process
        for process in processes
        if _windows_path(process.get("ExecutablePath") or "").startswith(prefix)
    ]


def normalize_process_listing(text):
    """ConvertTo-Json returns an object for one process and a list for several."""
    if not text.strip():
        return []
    data = json.loads(text)
    return [data] if isinstance(data, dict) else list(data)


def request(port, path, host=None, headers=None):
    """One GET over loopback; returns (status, body). The Host header can be forged."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        sent = {"Host": host or f"127.0.0.1:{port}", **(headers or {})}
        conn.request("GET", path, headers=sent)
        response = conn.getresponse()
        return response.status, response.read(4096).decode("utf-8", "replace")
    finally:
        conn.close()


def wait_until(check, timeout, interval=1.0):
    deadline = time.monotonic() + timeout
    while True:
        if check():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)


def read_new_text(path, offset):
    """The log text written after `offset`. A log the shell rotated at startup is
    shorter than the offset, and then everything in it is new."""
    if not path.is_file():
        return ""
    with path.open("rb") as handle:
        if handle.seek(0, os.SEEK_END) < offset:
            offset = 0
        handle.seek(offset)
        return handle.read().decode("utf-8", "replace")


def run_checked(command, timeout):
    completed = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if completed.returncode not in SUCCESS_CODES:
        raise SmokeError(f"{command[0]} exited with {completed.returncode}: {completed.stderr.strip()}")
    return completed


def list_processes():
    script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress"
    completed = run_checked(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], 120)
    return normalize_process_listing(completed.stdout)


def install(installer, timeout):
    if installer.suffix.lower() == ".msi":
        command = ["msiexec", "/i", str(installer), "/qn", "/norestart"]
    else:
        command = [str(installer), "/S"]
    run_checked(command, timeout)


def uninstall(installer, root, timeout):
    if installer.suffix.lower() == ".msi":
        run_checked(["msiexec", "/x", str(installer), "/qn", "/norestart"], timeout)
        return
    # The NSIS uninstaller hands off to a copy of itself, so wait for the file to go.
    subprocess.Popen([str(root / "uninstall.exe"), "/S"])
    if not wait_until(lambda: not (root / EXE_NAME).exists(), timeout):
        raise SmokeError("the NSIS uninstaller did not remove flowmap.exe")


def smoke(installer, timeout):
    app_data = Path(os.environ["APPDATA"]) / APP_ID
    shell_log = app_data / "shell.log"
    install(installer, timeout)
    root = find_install_root(install_roots(os.environ))
    exe = root / EXE_NAME
    offset = shell_log.stat().st_size if shell_log.is_file() else 0
    process = subprocess.Popen([str(exe)], cwd=str(root))
    try:
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
    finally:
        if process.poll() is None:
            subprocess.run(["taskkill", "/PID", str(process.pid)], capture_output=True)
            try:
                process.wait(timeout=60)
            except subprocess.TimeoutExpired:
                process.kill()
                raise SmokeError("the window did not close after WM_CLOSE; the shell was killed")

    if not wait_until(lambda: not leftover_sidecars(list_processes(), root), 30):
        left = leftover_sidecars(list_processes(), root)
        raise SmokeError(f"python processes survived the shell: {left}")
    uninstall(installer, root, timeout)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--installer", type=Path, required=True,
                        help="the .msi or the NSIS -setup.exe built by this leg")
    parser.add_argument("--timeout", type=float, default=180.0,
                        help="seconds allowed for each wait (install, health, exit)")
    args = parser.parse_args(argv)
    args.installer = args.installer.resolve()
    if os.name != "nt":
        print("packaged_smoke_windows: this check runs on Windows only", file=sys.stderr)
        return 2
    if not args.installer.is_file():
        print(f"packaged_smoke_windows: no installer at {args.installer}", file=sys.stderr)
        return 1
    try:
        smoke(args.installer, args.timeout)
    except (SmokeError, OSError, subprocess.SubprocessError) as error:
        print(f"packaged_smoke_windows: FAILED for {args.installer.name}: {error}", file=sys.stderr)
        return 1
    print(f"packaged_smoke_windows: passed for {args.installer.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
