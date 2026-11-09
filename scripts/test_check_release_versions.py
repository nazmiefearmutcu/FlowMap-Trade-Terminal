"""Version-consistency gate: offline fixtures plus the real repository."""

import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_release_versions as checker  # noqa: E402


REPO = Path(__file__).resolve().parents[1]
FILES = (
    "app/src-tauri/tauri.conf.json",
    "app/src-tauri/Cargo.toml",
    "app/src-tauri/Cargo.lock",
    "client/package.json",
    "client/package-lock.json",
    "server/pyproject.toml",
    "server/uv.lock",
    "server/src/flowmap_server/__init__.py",
)


class ReleaseVersionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        for name in FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / name, target)

        version = checker.collect_versions(self.root)["Tauri"]
        (self.root / "CHANGELOG.md").write_text(f"## [{version}] — 2026-11-10" + chr(10), encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def edit(self, name, old, new):
        path = self.root / name
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text)
        path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")

    def test_repository_versions_agree(self):
        self.assertEqual(checker.problems(checker.collect_versions(REPO)), [])

    def test_copied_fixture_is_consistent(self):
        self.assertEqual(checker.problems(checker.collect_versions(self.root)), [])

    def test_one_drifted_field_is_reported(self):
        version = checker.collect_versions(self.root)["Tauri"]
        self.edit("server/uv.lock", f'name = "flowmap-server"\nversion = "{version}"',
                  'name = "flowmap-server"\nversion = "9.9.9"')
        found = checker.problems(checker.collect_versions(self.root))
        self.assertEqual(len(found), 1)
        self.assertIn("'Server lock': '9.9.9'", found[0])

    def test_tag_must_match_every_field(self):
        versions = checker.collect_versions(self.root)
        version = versions["Tauri"]
        self.assertEqual(checker.problems(versions, f"v{version}"), [])
        self.assertTrue(checker.problems(versions, "v9.9.9"))

    def test_four_part_and_malformed_tags_are_rejected(self):
        versions = checker.collect_versions(self.root)
        for tag in ("v1.5.1.2", "1.5.1", "v1.5", "v1.5.1-beta"):
            with self.subTest(tag=tag):
                found = checker.problems(versions, tag)
                self.assertEqual(len(found), 1)
                self.assertIn("Invalid release tag", found[0])

    def test_cli_exit_status(self):
        version = checker.collect_versions(self.root)["Tauri"]
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(checker.main(["--root", str(self.root), "--tag", f"v{version}"]), 0)
        self.assertIn("match", out.getvalue())
        with redirect_stdout(io.StringIO()), redirect_stderr(err):
            self.assertEqual(checker.main(["--root", str(self.root), "--tag", "v0.0.1"]), 1)
        self.assertIn("inconsistent", err.getvalue())

    def test_missing_file_fails_closed(self):
        (self.root / "server/uv.lock").unlink()
        with redirect_stderr(io.StringIO()):
            self.assertEqual(checker.main(["--root", str(self.root)]), 1)

    def test_tagged_changelog_heading_must_be_dated(self):
        version = checker.collect_versions(self.root)["Tauri"]
        changelog = self.root / "CHANGELOG.md"
        changelog.write_text(f"## [{version}] — Unreleased" + chr(10), encoding="utf-8")
        self.assertTrue(checker.changelog_problems(self.root, f"v{version}"))
        with redirect_stderr(io.StringIO()) as err:
            self.assertEqual(checker.main(["--root", str(self.root), "--tag", f"v{version}"]), 1)
        self.assertIn("Unreleased", err.getvalue())
        changelog.write_text(f"## [{version}] — 2026-11-10" + chr(10), encoding="utf-8")
        self.assertEqual(checker.changelog_problems(self.root, f"v{version}"), [])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main(["--root", str(self.root), "--tag", f"v{version}"]), 0)

    def test_tagged_version_without_changelog_heading_fails(self):
        version = checker.collect_versions(self.root)["Tauri"]
        (self.root / "CHANGELOG.md").write_text("## [0.0.1] — 2026-01-01" + chr(10), encoding="utf-8")
        found = checker.changelog_problems(self.root, f"v{version}")
        self.assertEqual(len(found), 1)
        self.assertIn("no", found[0])


if __name__ == "__main__":
    unittest.main()
