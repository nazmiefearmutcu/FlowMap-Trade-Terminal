"""Tests for the pure helpers of scripts/packaged_smoke_posix.py.

The installed-app run needs a Linux or macOS runner with the built installers, so
it is the release workflow's job; these tests pin the decisions it makes from the
output and the file layout.
"""

from pathlib import Path
import tempfile
import unittest

import packaged_smoke_posix as smoke
from packaged_smoke_windows import SmokeError


class InstallerPlatformTests(unittest.TestCase):
    def test_each_installer_suffix_names_its_platform(self):
        self.assertEqual(smoke.platform_for(Path("FlowMap_1.5.1_amd64.deb")), "linux")
        self.assertEqual(smoke.platform_for(Path("FlowMap_1.5.1_amd64.AppImage")), "linux")
        self.assertEqual(smoke.platform_for(Path("FlowMap_1.5.1_aarch64.dmg")), "darwin")

    def test_the_windows_installers_have_no_posix_smoke(self):
        self.assertIsNone(smoke.platform_for(Path("FlowMap_1.5.1_x64-setup.exe")))
        self.assertIsNone(smoke.platform_for(Path("FlowMap_1.5.1_x64_en-US.msi")))


class AppDataTests(unittest.TestCase):
    def test_linux_uses_xdg_data_home_when_it_is_set(self):
        path = smoke.app_data_dir("linux", {"XDG_DATA_HOME": "/data"}, "/home/runner")
        self.assertEqual(path, Path("/data") / smoke.APP_ID)

    def test_linux_falls_back_to_the_local_share_folder(self):
        path = smoke.app_data_dir("linux", {}, "/home/runner")
        self.assertEqual(path, Path("/home/runner") / ".local" / "share" / smoke.APP_ID)

    def test_macos_keeps_the_app_data_under_application_support(self):
        path = smoke.app_data_dir("darwin", {"XDG_DATA_HOME": "/ignored"}, "/Users/runner")
        self.assertEqual(path, Path("/Users/runner") / "Library" / "Application Support" / smoke.APP_ID)


class LeftoverSidecarTests(unittest.TestCase):
    def test_a_sidecar_server_process_is_a_leftover(self):
        listing = "  101 /usr/lib/flowmap/pyruntime/bin/python3.13 -m flowmap_server\n"
        self.assertEqual(smoke.leftover_sidecars(listing), [101])

    def test_unrelated_processes_are_not_leftovers(self):
        listing = "  1 /sbin/init\n  2 /usr/bin/Xvfb :99\n  3 flowmap\n"
        self.assertEqual(smoke.leftover_sidecars(listing), [])

    def test_an_empty_listing_has_no_leftovers(self):
        self.assertEqual(smoke.leftover_sidecars(""), [])

    def test_lines_without_a_numeric_pid_are_ignored(self):
        self.assertEqual(smoke.leftover_sidecars("header flowmap_server\n"), [])


class ExecutableTests(unittest.TestCase):
    def test_the_shell_binary_is_preferred_inside_the_bundle(self):
        with tempfile.TemporaryDirectory() as folder:
            macos = Path(folder)
            (macos / "helper").write_text("")
            (macos / "flowmap").write_text("")
            self.assertEqual(smoke.find_executable_in(macos).name, "flowmap")

    def test_an_empty_bundle_folder_is_a_smoke_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(SmokeError):
                smoke.find_executable_in(Path(folder))


if __name__ == "__main__":
    unittest.main()
