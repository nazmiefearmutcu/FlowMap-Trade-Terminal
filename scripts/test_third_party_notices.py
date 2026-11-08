"""Tests for scripts/third_party_notices.py (stdlib unittest, no installs)."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import third_party_notices as notices


def write_dist(site, name, version, *, extra=""):
    folder = site / f"{name}-{version}.dist-info"
    folder.mkdir(parents=True)
    (folder / "METADATA").write_text(
        f"Metadata-Version: 2.4\nName: {name}\nVersion: {version}\n{extra}\nBody text.\n",
        encoding="utf-8",
    )


class PythonComponentTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.site = self.root / "Lib" / "site-packages"
        self.site.mkdir(parents=True)

    def tearDown(self):
        self._tmp.cleanup()

    def test_licence_expression_wins_over_the_older_fields(self):
        write_dist(self.site, "alpha", "1.0", extra="License: MIT\nLicense-Expression: Apache-2.0\n")
        (component,) = notices.python_components([self.site])
        self.assertEqual((component.name, component.version, component.license), ("alpha", "1.0", "Apache-2.0"))

    def test_short_licence_field_is_used(self):
        write_dist(self.site, "beta", "2.0", extra="License: BSD-3-Clause\n")
        (component,) = notices.python_components([self.site])
        self.assertEqual(component.license, "BSD-3-Clause")

    def test_classifier_is_the_fallback_when_the_field_is_pasted_text(self):
        # Folded header lines start with a space, as in real METADATA files.
        pasted = "Permission is hereby granted,\n free of charge, to any person"
        write_dist(
            self.site,
            "gamma",
            "3.0",
            extra=f"License: {pasted}\nClassifier: License :: OSI Approved :: MIT License\n",
        )
        (component,) = notices.python_components([self.site])
        self.assertEqual(component.license, "MIT License")

    def test_a_distribution_with_no_licence_is_unknown_and_counted(self):
        write_dist(self.site, "delta", "4.0", extra="License: UNKNOWN\n")
        (component,) = notices.python_components([self.site])
        self.assertEqual(component.license, notices.UNKNOWN)
        self.assertEqual(notices.unknown_count([component]), 1)

    def test_flowmap_itself_is_not_a_third_party_component(self):
        write_dist(self.site, "flowmap-server", "1.5.1", extra="")
        write_dist(self.site, "alpha", "1.0", extra="License: MIT\n")
        names = [item.name for item in notices.python_components([self.site])]
        self.assertEqual(names, ["alpha"])

    def test_duplicate_distributions_are_listed_once_and_sorted(self):
        other = self.root / "other" / "site-packages"
        other.mkdir(parents=True)
        write_dist(self.site, "zeta", "1.0", extra="License: MIT\n")
        write_dist(other, "Zeta", "1.0", extra="License: MIT\n")
        write_dist(self.site, "alpha", "9.9", extra="License: MIT\n")
        names = [item.name for item in notices.python_components([self.site, other])]
        self.assertEqual(names, ["alpha", "zeta"])

    def test_both_runtime_layouts_are_found(self):
        unix = self.root / "lib" / "python3.13" / "site-packages"
        unix.mkdir(parents=True)
        found = notices.find_site_packages(self.root)
        self.assertIn(self.site, found)
        self.assertIn(unix, found)

    def test_a_runtime_without_site_packages_is_refused(self):
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaises(FileNotFoundError):
            notices.find_site_packages(empty)


class NpmComponentTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.client = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def install(self, key, version, license_value):
        folder = self.client / key
        folder.mkdir(parents=True)
        (folder / "package.json").write_text(
            json.dumps({"name": key.rsplit("node_modules/", 1)[-1], "version": version, "license": license_value}),
            encoding="utf-8",
        )

    def write_lock(self, packages):
        (self.client / "package-lock.json").write_text(
            json.dumps({"lockfileVersion": 3, "packages": packages}), encoding="utf-8"
        )

    def test_only_production_packages_are_listed(self):
        self.install("node_modules/react", "18.3.1", "MIT")
        self.install("node_modules/vite", "7.0.0", "MIT")
        self.write_lock(
            {
                "": {"name": "client"},
                "node_modules/react": {"version": "18.3.1"},
                "node_modules/vite": {"version": "7.0.0", "dev": True},
            }
        )
        items = notices.npm_components(self.client)
        self.assertEqual([(item.name, item.version, item.license) for item in items], [("react", "18.3.1", "MIT")])

    def test_a_nested_package_keeps_its_own_name(self):
        self.install("node_modules/outer/node_modules/inner", "1.2.3", {"type": "ISC"})
        self.write_lock({"node_modules/outer/node_modules/inner": {"version": "1.2.3"}})
        (item,) = notices.npm_components(self.client)
        self.assertEqual((item.name, item.license), ("inner", "ISC"))

    def test_a_package_without_an_installed_manifest_is_unknown(self):
        self.write_lock({"node_modules/ghost": {"version": "0.1.0"}})
        (item,) = notices.npm_components(self.client)
        self.assertEqual((item.name, item.version, item.license), ("ghost", "0.1.0", notices.UNKNOWN))


class RenderAndCliTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        site = self.root / "runtime" / "lib" / "python3.13" / "site-packages"
        site.mkdir(parents=True)
        write_dist(site, "numpy", "2.0.0", extra="License-Expression: BSD-3-Clause\n")
        client = self.root / "client"
        folder = client / "node_modules" / "zustand"
        folder.mkdir(parents=True)
        (folder / "package.json").write_text(json.dumps({"version": "5.0.0", "license": "MIT"}), encoding="utf-8")
        (client / "package-lock.json").write_text(
            json.dumps({"packages": {"node_modules/zustand": {"version": "5.0.0"}}}), encoding="utf-8"
        )

    def tearDown(self):
        self._tmp.cleanup()

    def test_render_names_both_groups_and_the_version(self):
        text = notices.render(
            "9.9.9",
            notices.python_components(notices.find_site_packages(self.root / "runtime")),
            notices.npm_components(self.root / "client"),
        )
        self.assertIn("FlowMap 9.9.9 - third-party notices", text)
        self.assertIn("Python packages in the bundled runtime (1)", text)
        self.assertIn("- numpy 2.0.0 - BSD-3-Clause", text)
        self.assertIn("Client packages bundled in the web app (1)", text)
        self.assertIn("- zustand 5.0.0 - MIT", text)
        self.assertTrue(text.endswith("\n"))

    def test_cli_writes_the_file_and_succeeds(self):
        out = self.root / "THIRD-PARTY-NOTICES.txt"
        status = notices.main([
            "--runtime", str(self.root / "runtime"),
            "--client", str(self.root / "client"),
            "--version", "1.2.3",
            "--out", str(out),
        ])
        self.assertEqual(status, 0)
        self.assertIn("FlowMap 1.2.3", out.read_text(encoding="utf-8"))

    def test_cli_fails_when_the_runtime_is_missing(self):
        status = notices.main([
            "--runtime", str(self.root / "missing"),
            "--client", str(self.root / "client"),
            "--version", "1.2.3",
            "--out", str(self.root / "out.txt"),
        ])
        self.assertEqual(status, 1)
        self.assertFalse((self.root / "out.txt").exists())


class CargoComponentTests(unittest.TestCase):
    METADATA = {
        "packages": [
            {"name": "flowmap", "version": "1.5.1", "source": None, "license": None},
            {"name": "tauri", "version": "2.11.5", "source": "registry+https://github.com/rust-lang/crates.io-index",
             "license": "Apache-2.0 OR MIT"},
            {"name": "serde", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index",
             "license": "MIT OR Apache-2.0"},
            # The same crate version listed twice (two build targets) appears once.
            {"name": "Serde", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index",
             "license": "MIT OR Apache-2.0"},
            {"name": "mystery", "version": "0.1.0", "source": "registry+https://github.com/rust-lang/crates.io-index",
             "license": None},
            {"name": "gitdep", "version": "0.2.0", "source": "git+https://example.invalid/gitdep",
             "license": "BSD-2-Clause"},
        ]
    }

    def test_registry_and_git_crates_are_listed_and_path_crates_are_not(self):
        items = notices.cargo_components(self.METADATA)
        self.assertEqual(
            [(item.name, item.version, item.license) for item in items],
            [
                ("gitdep", "0.2.0", "BSD-2-Clause"),
                ("mystery", "0.1.0", notices.UNKNOWN),
                ("serde", "1.0.0", "MIT OR Apache-2.0"),
                ("tauri", "2.11.5", "Apache-2.0 OR MIT"),
            ],
        )

    def test_a_crate_without_a_licence_is_counted_as_unknown(self):
        items = notices.cargo_components(self.METADATA)
        self.assertEqual(notices.unknown_count(items), 1)

    def test_render_adds_the_rust_section_only_when_crates_were_read(self):
        items = notices.cargo_components(self.METADATA)
        with_crates = notices.render("9.9.9", [], [], items)
        self.assertIn("Rust crates of the desktop shell (4)", with_crates)
        self.assertIn("- tauri 2.11.5 - Apache-2.0 OR MIT", with_crates)
        without = notices.render("9.9.9", [], [])
        self.assertNotIn("Rust crates", without)

    def test_a_failed_cargo_metadata_run_is_refused(self):
        # Refused either way: cargo rejects the missing manifest, or cargo is not installed.
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises((ValueError, OSError)):
                notices.read_cargo_metadata(Path(tmp) / "no-such-crate")


TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
]


class PerTargetNoticesTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.fonts = self.root / "fonts"
        self.fonts.mkdir()
        (self.fonts / "LICENSE-inter.txt").write_text(
            "Copyright 2016 The Inter Project Authors.\nSIL Open Font License, Version 1.1.\n",
            encoding="utf-8",
        )
        (self.fonts / "LICENSE-jetbrains-mono.txt").write_text(
            "Copyright 2020 The JetBrains Mono Project Authors.\n", encoding="utf-8")

    def tearDown(self):
        self._tmp.cleanup()

    def _part(self, target, python, cargo=None):
        return notices.part_document(
            target,
            [notices.Component(n, v, lic) for n, v, lic in python],
            [notices.Component("zustand", "5.0.0", "MIT")],
            None if cargo is None else [notices.Component("serde", "1.0.0", "MIT OR Apache-2.0")],
            notices.font_licences(self.fonts),
        )

    def test_font_licence_texts_are_read_with_readable_names(self):
        fonts = notices.font_licences(self.fonts)
        self.assertEqual([font.name for font in fonts], ["Inter", "JetBrains Mono"])
        self.assertIn("SIL Open Font License, Version 1.1.", fonts[0].text)

    def test_an_empty_font_licence_is_refused(self):
        (self.fonts / "LICENSE-empty.txt").write_text("\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            notices.font_licences(self.fonts)

    def test_a_missing_font_licence_set_is_refused(self):
        empty = self.root / "no-fonts"
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, "no font licence texts"):
            notices.font_licences(empty)

    def test_render_carries_the_font_texts_only_when_given(self):
        fonts = notices.font_licences(self.fonts)
        with_fonts = notices.render("1.0.0", [], [], None, fonts)
        self.assertIn("Fonts bundled in the web app (2)", with_fonts)
        self.assertIn("Copyright 2020 The JetBrains Mono Project Authors.", with_fonts)
        self.assertNotIn("Fonts bundled", notices.render("1.0.0", [], []))

    def test_each_target_keeps_its_own_python_packages(self):
        parts = [
            self._part("x86_64-pc-windows-msvc", [("colorama", "0.4.6", "BSD")]),
            self._part("x86_64-unknown-linux-gnu", [("uvloop", "0.21.0", "MIT")], cargo=True),
        ]
        text = notices.merge_parts("1.5.1", parts, ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"])
        self.assertIn("Python packages in the bundled runtime for x86_64-pc-windows-msvc (1)", text)
        self.assertIn("- colorama 0.4.6 - BSD", text)
        self.assertIn("Python packages in the bundled runtime for x86_64-unknown-linux-gnu (1)", text)
        self.assertIn("- uvloop 0.21.0 - MIT", text)
        self.assertIn("Rust crates of the desktop shell (1)", text)
        self.assertIn("Fonts bundled in the web app (2)", text)
        self.assertTrue(text.startswith("FlowMap 1.5.1 - third-party notices"))

    def test_a_missing_target_refuses_the_release(self):
        parts = [self._part("x86_64-unknown-linux-gnu", [], cargo=True)]
        with self.assertRaisesRegex(ValueError, "missing notices part for x86_64-pc-windows-msvc"):
            notices.merge_parts("1.5.1", parts, ["x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc"])

    def test_an_unexpected_or_duplicate_target_is_refused(self):
        linux = self._part("x86_64-unknown-linux-gnu", [], cargo=True)
        with self.assertRaisesRegex(ValueError, "unexpected notices part"):
            notices.merge_parts("1.5.1", [linux, self._part("riscv64", [])], ["x86_64-unknown-linux-gnu"])
        with self.assertRaisesRegex(ValueError, "duplicate notices part"):
            notices.merge_parts("1.5.1", [linux, dict(linux)], ["x86_64-unknown-linux-gnu"])

    def test_exactly_one_part_must_carry_the_rust_graph(self):
        none = self._part("x86_64-unknown-linux-gnu", [])
        with self.assertRaisesRegex(ValueError, "exactly one part must carry the Rust crate graph"):
            notices.merge_parts("1.5.1", [none], ["x86_64-unknown-linux-gnu"])

    def test_a_document_that_is_not_a_part_is_refused(self):
        with self.assertRaisesRegex(ValueError, "not a third-party notices part"):
            notices.merge_parts("1.5.1", [{"target": "x", "format": "other"}], ["x"])

    def test_cli_writes_a_part_and_merges_it_into_the_notices(self):
        runtime = self.root / "runtime" / "Lib" / "site-packages"
        write_dist(runtime, "colorama", "0.4.6")
        client = self.root / "client"
        client.mkdir()
        (client / "package-lock.json").write_text(json.dumps({"packages": {}}), encoding="utf-8")
        part = self.root / "part.json"
        status = notices.main([
            "--runtime", str(self.root / "runtime"), "--client", str(client),
            "--fonts", str(self.fonts), "--version", "1.5.1",
            "--target", "x86_64-pc-windows-msvc", "--out", str(part),
        ])
        self.assertEqual(status, 0)
        document = json.loads(part.read_text(encoding="utf-8"))
        self.assertEqual(document["target"], "x86_64-pc-windows-msvc")
        self.assertIsNone(document["cargo"])
        out = self.root / "THIRD-PARTY-NOTICES.txt"
        status = notices.main([
            "--merge", str(part), "--expect", "x86_64-pc-windows-msvc",
            "--version", "1.5.1", "--out", str(out),
        ])
        self.assertEqual(status, 1, "a part without the Rust graph cannot be the shared source")
        self.assertFalse(out.exists())

    def test_cli_merge_needs_the_expected_targets(self):
        with self.assertRaises(SystemExit):
            notices.main(["--merge", "part.json", "--version", "1.5.1", "--out", "out.txt"])

    def test_cli_requires_a_runtime_unless_merging(self):
        with self.assertRaises(SystemExit):
            notices.main(["--version", "1.5.1", "--out", str(self.root / "out.txt")])

    def test_the_release_targets_match_the_build_matrix(self):
        workflow = (notices.ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        for target in TARGETS:
            with self.subTest(target=target):
                self.assertIn(f"triple: {target}", workflow)
                self.assertIn(target, workflow.split("--expect ", 1)[1].split("\n", 1)[0])

    def _merge_cli(self, part, allow_text):
        part_path = self.root / "part.json"
        part_path.write_text(json.dumps(part), encoding="utf-8")
        allow = self.root / "allow.txt"
        allow.write_text(allow_text, encoding="utf-8")
        out = self.root / "THIRD-PARTY-NOTICES.txt"
        with contextlib.redirect_stderr(io.StringIO()) as err:
            status = notices.main([
                "--merge", str(part_path), "--expect", "x86_64-unknown-linux-gnu",
                "--version", "1.5.1", "--out", str(out), "--allow-unknown", str(allow),
            ])
        return status, out, err.getvalue()

    def test_an_unlisted_unknown_licence_refuses_the_merge(self):
        part = self._part("x86_64-unknown-linux-gnu", [("mystery", "1.0.0", notices.UNKNOWN)], cargo=True)
        status, out, err = self._merge_cli(part, "# nothing reviewed yet\n")
        self.assertEqual(status, 1)
        self.assertFalse(out.exists(), "a release with an unreviewed licence is never written")
        self.assertIn("mystery@1.0.0", err)

    def test_a_reviewed_unknown_licence_is_accepted(self):
        part = self._part("x86_64-unknown-linux-gnu", [("mystery", "1.0.0", notices.UNKNOWN)], cargo=True)
        status, out, _ = self._merge_cli(part, "mystery@1.0.0  # licence confirmed by the owner\n")
        self.assertEqual(status, 0)
        self.assertIn("- mystery 1.0.0 - UNKNOWN", out.read_text(encoding="utf-8"))

    def test_the_allow_list_ignores_comments_and_blank_lines(self):
        path = self.root / "allow.txt"
        path.write_text("# header\n\nfoo@1.0.0  # why\n  bar@2.0.0\n", encoding="utf-8")
        self.assertEqual(notices.load_unknown_allowlist(path), {"foo@1.0.0", "bar@2.0.0"})

    def test_the_committed_allow_list_is_present(self):
        self.assertTrue(notices.UNKNOWN_ALLOWLIST.is_file())
        self.assertEqual(notices.load_unknown_allowlist(notices.UNKNOWN_ALLOWLIST), set())


if __name__ == "__main__":
    unittest.main()
