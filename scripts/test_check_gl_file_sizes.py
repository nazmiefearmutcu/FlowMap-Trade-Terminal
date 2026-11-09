"""Tests for scripts/check_gl_file_sizes.py (stdlib unittest)."""

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_gl_file_sizes as checker  # noqa: E402

NO_CEILINGS = {}


class RatchetTests(unittest.TestCase):
    def test_unlisted_module_over_the_limit_fails(self):
        found = checker.problems({"client/src/gl/new.ts": checker.LIMIT + 1}, NO_CEILINGS)
        self.assertEqual(len(found), 1)
        self.assertIn("limit", found[0])

    def test_module_at_the_limit_passes(self):
        self.assertEqual(checker.problems({"client/src/gl/new.ts": checker.LIMIT}, NO_CEILINGS), [])

    def test_listed_module_may_not_grow_past_its_ceiling(self):
        path = "client/src/gl/renderer.ts"
        ceilings = {path: 1000}
        self.assertEqual(checker.problems({path: 1000}, ceilings), [])
        found = checker.problems({path: 1001}, ceilings)
        self.assertEqual(len(found), 1)
        self.assertIn("ceiling", found[0])

    def test_listed_module_may_be_small_without_a_problem(self):
        path = "client/src/gl/camera.ts"
        self.assertEqual(checker.problems({path: 100}, {path: 767}), [])

    def test_stale_ceiling_entry_is_reported(self):
        found = checker.problems({}, {"client/src/gl/gone.ts": 700})
        self.assertEqual(len(found), 1)
        self.assertIn("remove the entry", found[0])

    def test_tests_and_declarations_are_not_counted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gl = root / "client/src/gl"
            gl.mkdir(parents=True)
            (gl / "big.test.ts").write_text("x\n" * (checker.LIMIT + 50), encoding="utf-8")
            (gl / "types.d.ts").write_text("x\n" * (checker.LIMIT + 50), encoding="utf-8")
            (gl / "small.ts").write_text("x\n" * 3, encoding="utf-8")
            self.assertEqual(checker.line_counts(root), {"client/src/gl/small.ts": 3})

    def test_cli_reports_and_fails_on_an_oversized_module(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            gl = root / "client/src/gl"
            gl.mkdir(parents=True)
            (gl / "huge.ts").write_text("x\n" * (checker.LIMIT + 1), encoding="utf-8")
            err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(err):
                self.assertEqual(checker.main(["--root", str(root)]), 1)
            self.assertIn("huge.ts", err.getvalue())

    def test_repository_gl_modules_are_within_the_ratchet(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main([]), 0)


if __name__ == "__main__":
    unittest.main()
