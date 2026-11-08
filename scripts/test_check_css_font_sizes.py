"""Offline fixtures for the CSS raw px font-size ratchet (no repository state)."""

import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_css_font_sizes as checker  # noqa: E402


class PxFontSizeCountTests(unittest.TestCase):
    def test_counts_px_declarations(self):
        css = ".a { font-size: 12px; }\n.b{font-size:.5px}\n.c { font-size: 1.25PX; }"
        self.assertEqual(checker.count_px_font_sizes(css), 3)

    def test_token_and_rem_sizes_are_not_counted(self):
        css = ".a { font-size: var(--fs-md); } .b { font-size: 1rem; } .c { font-size: 120%; }"
        self.assertEqual(checker.count_px_font_sizes(css), 0)

    def test_custom_properties_and_longer_names_are_not_counted(self):
        css = ":root { --font-size: 12px; } .a { line-font-size: 12px; }"
        self.assertEqual(checker.count_px_font_sizes(css), 0)


class RatchetTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, True)
        (self.root / "client/src/ui").mkdir(parents=True)

    def write(self, rel, text):
        (self.root / rel).write_text(text, encoding="utf-8")

    def test_unbudgeted_stylesheet_with_px_is_refused(self):
        self.write("client/src/ui/New.css", ".a { font-size: 13px; }")
        lines = checker.problems(checker.scan(self.root), budgets={})
        self.assertEqual(len(lines), 1)
        self.assertIn("client/src/ui/New.css", lines[0])
        self.assertIn("src/theme", lines[0])

    def test_budgeted_stylesheet_at_its_budget_passes(self):
        self.write("client/src/ui/Old.css", ".a { font-size: 13px; } .b { font-size: 9px; }")
        budgets = {"client/src/ui/Old.css": 2}
        self.assertEqual(checker.problems(checker.scan(self.root), budgets=budgets), [])

    def test_growth_past_the_budget_is_refused(self):
        self.write("client/src/ui/Old.css", ".a { font-size: 13px; } .b { font-size: 9px; }")
        budgets = {"client/src/ui/Old.css": 1}
        lines = checker.problems(checker.scan(self.root), budgets=budgets)
        self.assertEqual(len(lines), 1)
        self.assertIn("budget 1", lines[0])

    def test_token_only_stylesheet_is_not_reported(self):
        self.write("client/src/ui/Clean.css", ".a { font-size: var(--fs-xs); }")
        self.assertEqual(checker.scan(self.root), {})

    def test_main_fails_and_names_the_offender(self):
        self.write("client/src/ui/New.css", ".a { font-size: 13px; }")
        err, out = io.StringIO(), io.StringIO()
        with redirect_stderr(err), redirect_stdout(out):
            code = checker.main(["--root", str(self.root)])
        self.assertEqual(code, 1)
        self.assertIn("New.css", err.getvalue())

    def test_real_tree_is_within_budget(self):
        counts = checker.scan(checker.ROOT)
        self.assertEqual(checker.problems(counts), [])

    def test_every_budget_is_tight_to_the_real_tree(self):
        # A budget above the live count lets a later regression hide in the slack.
        counts = checker.scan(checker.ROOT)
        for path, allowed in checker.BUDGETS.items():
            with self.subTest(path=path):
                self.assertEqual(counts.get(path, 0), allowed)


if __name__ == "__main__":
    unittest.main()
