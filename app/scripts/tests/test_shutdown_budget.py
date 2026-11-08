"""Keeps the shell's quit grace above the server's shutdown flush budget.

The server bounds its final recording flush by SHUTDOWN_FLUSH_DEADLINE_S
(server/src/flowmap_server/core/session_common.py). On a quit the shell closes the
sidecar's stdin and kills it after GRACEFUL_STOP (app/src-tauri/src/sidecar.rs). If
the shell's grace falls to the server's budget or below, a slow final flush is cut
short. An automatic restart must stay quicker than a quit.

Run from the repository root with:
    python3 -m unittest discover -s app/scripts/tests -p "test_*.py"
"""

import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SESSION_COMMON = REPO / "server" / "src" / "flowmap_server" / "core" / "session_common.py"
SIDECAR = REPO / "app" / "src-tauri" / "src" / "sidecar.rs"


def number(pattern: str, text: str) -> float:
    match = re.search(pattern, text, re.MULTILINE)
    if match is None:
        raise AssertionError(f"no match for {pattern!r}")
    return float(match.group(1))


def server_flush_budget(text: str) -> float:
    drain = number(r"^_REC_DRAIN_TIMEOUT_S\s*=\s*([\d.]+)", text)
    margin = number(
        r"^SHUTDOWN_FLUSH_DEADLINE_S\s*=\s*_REC_DRAIN_TIMEOUT_S\s*\+\s*([\d.]+)", text
    )
    return drain + margin


class ShutdownBudgetTest(unittest.TestCase):
    def setUp(self):
        self.server = SESSION_COMMON.read_text(encoding="utf-8")
        self.shell = SIDECAR.read_text(encoding="utf-8")
        self.budget = server_flush_budget(self.server)
        self.shell_budget = number(
            r"^const SERVER_FLUSH_DEADLINE_SECS: u64 = (\d+);", self.shell
        )
        self.quit_grace = number(
            r"^pub\(crate\) const GRACEFUL_STOP: Duration =\s*"
            r"Duration::from_secs\(SERVER_FLUSH_DEADLINE_SECS \+ (\d+)\);",
            self.shell,
        )
        self.restart_grace = number(
            r"^pub\(crate\) const RESTART_STOP: Duration = Duration::from_secs\((\d+)\);",
            self.shell,
        )

    def test_the_shell_tracks_the_servers_flush_budget(self):
        self.assertEqual(
            self.shell_budget,
            self.budget,
            "SERVER_FLUSH_DEADLINE_SECS in sidecar.rs must match SHUTDOWN_FLUSH_DEADLINE_S",
        )

    def test_a_quit_outlasts_the_servers_flush_budget(self):
        self.assertGreater(self.quit_grace, 0)
        self.assertGreater(
            self.shell_budget + self.quit_grace,
            self.budget,
            "the quit grace must exceed the server's flush budget",
        )

    def test_an_automatic_restart_does_not_wait_out_a_quit(self):
        self.assertLess(self.restart_grace, self.shell_budget + self.quit_grace)


if __name__ == "__main__":
    unittest.main()
