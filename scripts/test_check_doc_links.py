"""Offline tests for check_doc_links, plus a run over the real repository."""

import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_doc_links as checker  # noqa: E402


REPO = Path(__file__).resolve().parents[1]


class SlugTests(unittest.TestCase):
    def test_github_slug_rules(self):
        self.assertEqual(checker.github_slug("Run from source"), "run-from-source")
        self.assertEqual(checker.github_slug("What it writes"), "what-it-writes")
        self.assertEqual(checker.github_slug("`FLOWMAP_PORT` settings"), "flowmap_port-settings")
        self.assertEqual(checker.github_slug("Verify what you downloaded!"), "verify-what-you-downloaded")

    def test_duplicate_headings_get_numbered_anchors(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "doc.md"
            path.write_text("# Same\n\n## Same\n\n```\n# not a heading\n```\n", encoding="utf-8")
            self.assertEqual(checker.anchors_of(path), {"same", "same-1"})


class LinkTests(unittest.TestCase):
    def build(self, files):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        for name, text in files.items():
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return root

    def test_resolving_links_pass(self):
        root = self.build({
            "README.md": "# Top\n\n## Run from source\n",
            "docs/guide.md": "[ok](../README.md#run-from-source) [web](https://example.com) [mail](mailto:a@b.c)\n",
        })
        self.assertEqual(checker.check(root), [])

    def test_missing_file_and_anchor_are_reported(self):
        root = self.build({
            "README.md": "# Top\n",
            "docs/guide.md": "[bad anchor](../README.md#quickstart-from-source)\n[missing](nope.md)\n",
        })
        found = checker.check(root)
        self.assertEqual(len(found), 2)
        self.assertIn("missing anchor ../README.md#quickstart-from-source", found[0])
        self.assertIn("missing file nope.md", found[1])

    def test_links_inside_code_fences_are_ignored(self):
        root = self.build({"doc.md": "```\n[x](nope.md)\n```\n"})
        self.assertEqual(checker.check(root), [])

    def test_cli_exit_status(self):
        root = self.build({"doc.md": "[x](nope.md)\n"})
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(checker.main(["--root", str(root)]), 1)
        self.assertIn("missing file nope.md", err.getvalue())


class RepositoryTests(unittest.TestCase):
    def test_repository_documentation_links_resolve(self):
        self.assertEqual(checker.check(REPO), [])


if __name__ == "__main__":
    unittest.main()
