"""Regression checks for the installer text and the hash-pinned Python install.

Run from the repository root with:
    python3 -m unittest discover -s app/scripts/tests -p "test_*.py"
"""

import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "app"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class ReleaseTextTest(unittest.TestCase):
    def test_the_dmg_first_run_line_gives_the_macos_15_steps(self):
        match = re.search(
            r'^LINE2 = "(.*)"$', read(APP / "icons" / "dmg" / "make-bg.py"), re.MULTILINE
        )
        self.assertIsNotNone(match, "make-bg.py no longer defines LINE2")
        self.assertIn("System Settings → Privacy & Security → Open Anyway", match.group(1))
        self.assertNotIn("right-click", match.group(1).lower())

    def test_the_before_build_command_points_at_the_client_from_the_app_directory(self):
        # Tauri runs beforeBuildCommand from app/ (the parent of src-tauri), not from
        # src-tauri. A prefix one level too high failed every installer build.
        command = json.loads(read(APP / "src-tauri" / "tauri.conf.json"))["build"]["beforeBuildCommand"]
        prefix = re.search(r"--prefix (\S+)", command)
        self.assertIsNotNone(prefix, command)
        self.assertTrue((APP / prefix.group(1) / "package.json").is_file(), command)

    def test_the_first_run_steps_match_across_the_installer_and_the_docs(self):
        for path in (APP / "scripts" / "build-dmg.sh", REPO / "SECURITY.md", APP / "README.md"):
            text = read(path)
            self.assertIn("System Settings → Privacy & Security", text, path)
            self.assertIn("Open Anyway", text, path)

    def test_the_bundled_python_installs_only_hash_checked_requirements(self):
        script = read(APP / "scripts" / "bundle-python.sh")
        self.assertNotIn("--no-hashes", script)
        install_args = re.search(r"^PIP_INSTALL_ARGS=\((.*)\)$", script, re.MULTILINE)
        self.assertIsNotNone(install_args, "PIP_INSTALL_ARGS is no longer defined")
        self.assertIn("--require-hashes", install_args.group(1))
        self.assertIn('requirements_pins.py" check-hashes', script)


if __name__ == "__main__":
    unittest.main()
