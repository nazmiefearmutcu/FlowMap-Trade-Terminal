"""Tests for the pure helpers of scripts/packaged_smoke_windows.py.

The end-to-end run needs a Windows runner with an installed build, so it is the
release workflow's job; these tests pin the decisions it makes from the output.
"""

from pathlib import Path
import tempfile
import unittest

import packaged_smoke_windows as smoke


class SidecarPortTests(unittest.TestCase):
    def test_the_first_spawn_port_is_read_from_the_shell_log(self):
        text = (
            "2026-11-08T10:00:00Z starting sidecar C:\\app\\pyruntime\\python.exe "
            "-m flowmap_server on :53412 (spawn 0)\n"
        )
        self.assertEqual(smoke.sidecar_port(text), 53412)

    def test_a_respawn_line_alone_is_not_this_runs_sidecar(self):
        text = "2026-11-08T10:05:00Z starting sidecar python -m flowmap_server on :40000 (spawn 2)\n"
        self.assertIsNone(smoke.sidecar_port(text))

    def test_nothing_logged_yet_means_no_port(self):
        self.assertIsNone(smoke.sidecar_port(""))
        self.assertIsNone(smoke.sidecar_port("2026-11-08T10:00:00Z FlowMap 1.5.1 starting\n"))


class ReadNewTextTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.log = Path(self._tmp.name) / "shell.log"

    def tearDown(self):
        self._tmp.cleanup()

    def test_only_text_after_the_offset_is_read(self):
        # Bytes, not text: Windows text mode would turn "\n" into "\r\n".
        self.log.write_bytes(b"old line\n")
        offset = self.log.stat().st_size
        with self.log.open("ab") as handle:
            handle.write(b"new line\n")
        self.assertEqual(smoke.read_new_text(self.log, offset), "new line\n")

    def test_a_log_rotated_at_startup_is_read_from_its_start(self):
        self.log.write_bytes(b"x" * 500)
        offset = self.log.stat().st_size
        self.log.write_bytes(b"starting sidecar on :1 (spawn 0)\n")
        self.assertIn("(spawn 0)", smoke.read_new_text(self.log, offset))

    def test_a_missing_log_reads_as_empty(self):
        self.assertEqual(smoke.read_new_text(self.log, 0), "")


class HealthTests(unittest.TestCase):
    def test_only_a_200_with_status_ok_counts(self):
        self.assertTrue(smoke.is_healthy(200, '{"status":"ok"}'))
        self.assertTrue(smoke.is_healthy(200, '{"status": "ok", "uptime": 3}'))

    def test_other_answers_do_not_count(self):
        self.assertFalse(smoke.is_healthy(401, '{"status":"ok"}'))
        self.assertFalse(smoke.is_healthy(200, '{"status":"degraded"}'))
        self.assertFalse(smoke.is_healthy(503, ""))


class InstallRootTests(unittest.TestCase):
    def test_the_msi_and_the_per_user_locations_are_searched(self):
        roots = smoke.install_roots({
            "PROGRAMFILES": "C:\\Program Files",
            "LOCALAPPDATA": "C:\\Users\\runner\\AppData\\Local",
        })
        self.assertEqual(roots[0], Path("C:\\Program Files") / "FlowMap")
        self.assertIn(Path("C:\\Users\\runner\\AppData\\Local") / "Programs" / "FlowMap", roots)

    def test_the_first_root_holding_the_executable_wins(self):
        first, second = Path("C:/one/FlowMap"), Path("C:/two/FlowMap")
        present = {second / smoke.EXE_NAME}
        found = smoke.find_install_root([first, second], exists=lambda path: path in present)
        self.assertEqual(found, second)

    def test_a_missing_install_names_every_place_it_looked(self):
        roots = [Path("C:/one/FlowMap"), Path("C:/two/FlowMap")]
        with self.assertRaises(smoke.SmokeError) as raised:
            smoke.find_install_root(roots, exists=lambda path: False)
        for root in roots:
            self.assertIn(str(root), str(raised.exception))


class LeftoverTests(unittest.TestCase):
    ROOT = Path("C:/Program Files/FlowMap")

    def test_a_python_under_the_installed_runtime_is_a_leftover(self):
        processes = [{"ProcessId": 7, "ExecutablePath": "C:\\Program Files\\FlowMap\\pyruntime\\python.exe"}]
        self.assertEqual(smoke.leftover_sidecars(processes, self.ROOT), processes)

    def test_matching_ignores_case(self):
        processes = [{"ProcessId": 8, "ExecutablePath": "c:\\program files\\flowmap\\pyruntime\\PYTHON.EXE"}]
        self.assertEqual(len(smoke.leftover_sidecars(processes, self.ROOT)), 1)

    def test_a_sibling_folder_with_the_same_prefix_is_not_a_leftover(self):
        processes = [{"ProcessId": 9, "ExecutablePath": "C:\\Program Files\\FlowMapTools\\python.exe"}]
        self.assertEqual(smoke.leftover_sidecars(processes, self.ROOT), [])

    def test_processes_without_a_path_are_ignored(self):
        processes = [{"ProcessId": 10, "ExecutablePath": None}, {"ProcessId": 11}]
        self.assertEqual(smoke.leftover_sidecars(processes, self.ROOT), [])


class ProcessListingTests(unittest.TestCase):
    def test_an_empty_listing_is_no_processes(self):
        self.assertEqual(smoke.normalize_process_listing(""), [])
        self.assertEqual(smoke.normalize_process_listing("  \n"), [])

    def test_a_single_process_object_becomes_a_list(self):
        text = '{"ProcessId": 4, "ExecutablePath": "C:\\\\x\\\\python.exe"}'
        self.assertEqual(smoke.normalize_process_listing(text), [{"ProcessId": 4, "ExecutablePath": "C:\\x\\python.exe"}])

    def test_several_processes_stay_a_list(self):
        text = '[{"ProcessId": 1, "ExecutablePath": null}, {"ProcessId": 2, "ExecutablePath": null}]'
        self.assertEqual([item["ProcessId"] for item in smoke.normalize_process_listing(text)], [1, 2])


if __name__ == "__main__":
    unittest.main()
