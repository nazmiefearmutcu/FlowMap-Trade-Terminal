"""Offline fixtures for the DMG artwork stamp check (no repository state)."""

import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_dmg_art as checker  # noqa: E402


class DmgArtStampTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "app/src-tauri").mkdir(parents=True)
        (self.root / "app/icons/dmg").mkdir(parents=True)
        self.set_app_version("2.0.0")

    def set_app_version(self, version):
        (self.root / checker.TAURI_CONF).write_text(
            '{\n  "version": "%s"\n}\n' % version, encoding="utf-8"
        )

    def set_stamp(self, text):
        (self.root / checker.STAMP).write_text(text, encoding="utf-8")

    def test_matching_stamp_passes(self):
        self.set_stamp("2.0.0\n")
        self.assertIsNone(checker.mismatch(self.root))

    def test_stale_stamp_is_refused_with_both_versions(self):
        self.set_stamp("1.3.1\n")
        problem = checker.mismatch(self.root)
        self.assertIn("'1.3.1'", problem)
        self.assertIn("'2.0.0'", problem)

    def test_missing_stamp_is_refused(self):
        self.assertIn("missing", checker.mismatch(self.root))

    def test_stamp_whitespace_is_ignored(self):
        self.set_stamp("  2.0.0  \r\n")
        self.assertIsNone(checker.mismatch(self.root))

    def test_main_returns_nonzero_and_names_the_fix(self):
        self.set_stamp("1.0.0\n")
        err, out = io.StringIO(), io.StringIO()
        with redirect_stderr(err), redirect_stdout(out):
            code = checker.main(["--root", str(self.root)])
        self.assertEqual(code, 1)
        self.assertIn("make-bg.py 2.0.0 --all", err.getvalue())

    def test_main_passes_on_matching_stamp(self):
        self.set_stamp("2.0.0\n")
        out = io.StringIO()
        with redirect_stdout(out):
            code = checker.main(["--root", str(self.root)])
        self.assertEqual(code, 0)
        self.assertIn("matches app version 2.0.0", out.getvalue())


if __name__ == "__main__":
    unittest.main()
