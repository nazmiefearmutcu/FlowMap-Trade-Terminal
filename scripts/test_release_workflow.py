"""Static guards on the release and CI workflows (no YAML dependency).

These pin the properties the release pipeline relies on: least privilege, the
publish gate, the CI gate in front of every release, and no swallowed failures.
"""

from pathlib import Path

import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
RELEASE = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
CI = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")

def job_block(text, name):
    """Lines of one job under `jobs:` (2-space key, body indented further)."""
    lines = text.splitlines()
    start = lines.index(f"  {name}:")
    body = []
    for line in lines[start + 1:]:
        if line and not line.startswith("   ") and not line.startswith("#"):
            break
        body.append(line)
    return "\n".join(body)

class ReleaseWorkflowTests(unittest.TestCase):
    def test_default_token_scope_is_empty(self):
        self.assertIn("\npermissions: {}\n", RELEASE)

    def test_only_publish_holds_write_scope(self):
        for job in ("prepare", "build", "gate"):
            with self.subTest(job=job):
                self.assertNotIn("contents: write", job_block(RELEASE, job))
        self.assertIn("contents: write", job_block(RELEASE, "publish"))
        self.assertNotIn("release-draft:", RELEASE)

    def test_build_legs_have_no_token_or_signing_scope(self):
        build = job_block(RELEASE, "build")
        self.assertNotIn("secrets.", build)
        self.assertNotIn("id-token", build)
        self.assertNotIn("attestations", build)
        self.assertNotIn("--break-system-packages", build)
        self.assertIn("actions/upload-artifact", build)

    def test_github_token_reaches_only_the_bundle_steps(self):
        # The token lets bundle-python.sh authenticate its release lookup. It may
        # appear only in the steps that run that script, never as a job-wide value.
        build = job_block(RELEASE, "build")
        self.assertIn("permissions:\n      contents: read", build)
        steps = build.split("\n      - name:")
        with_token = [step for step in steps if "GITHUB_TOKEN:" in step]
        self.assertEqual(len(with_token), 2)
        for step in with_token:
            self.assertIn("GITHUB_TOKEN: ${{ github.token }}", step)
            self.assertTrue("bundle-python.sh" in step or "build-dmg.sh" in step)

    def test_dmg_artwork_is_verified_not_rendered_on_the_runner(self):
        build = job_block(RELEASE, "build")
        self.assertIn("scripts/check_dmg_art.py", build)
        self.assertNotIn("make-bg.py", build)
        self.assertNotIn("pip install", build)

    def test_attestation_and_upload_happen_only_in_publish(self):
        self.assertIn("actions/attest-build-provenance", job_block(RELEASE, "publish"))
        self.assertNotIn("actions/attest-build-provenance", job_block(RELEASE, "build"))
        self.assertIn("gh release upload", job_block(RELEASE, "publish"))
        self.assertNotIn("gh release upload", job_block(RELEASE, "build"))

    def test_publish_runs_behind_the_release_environment(self):
        self.assertIn("environment:\n      name: release", job_block(RELEASE, "publish"))

    def test_full_ci_gate_precedes_every_release_job(self):
        self.assertIn("uses: ./.github/workflows/ci.yml", job_block(RELEASE, "gate"))
        self.assertIn("needs: [prepare, gate]", job_block(RELEASE, "build"))
        self.assertIn("needs: [prepare, build]", job_block(RELEASE, "publish"))
        self.assertIn("needs.gate.result == 'success'", job_block(RELEASE, "build"))
        self.assertIn("needs.gate.result", RELEASE)

    def test_publish_verifies_uploaded_bytes(self):
        publish = job_block(RELEASE, "publish")
        self.assertIn("gh release download", publish)
        self.assertIn("sha256sum -c SHA256SUMS", publish)
        self.assertLess(publish.index("sha256sum -c SHA256SUMS"),
                        publish.index("Publish the release"))

    def test_no_failure_is_swallowed(self):
        # The smoke test's `kill ... || true` is deliberate (the server may
        # already be gone); cleanup and publication must not swallow errors.
        self.assertNotIn("|| true", job_block(RELEASE, "publish"))
        self.assertNotIn("done || true", RELEASE)
        self.assertNotIn("continue-on-error", RELEASE)

    def test_four_part_tags_are_not_accepted(self):
        self.assertNotIn("[0-9]+(\\.[0-9]+){2,3}", RELEASE)
        self.assertNotIn("v[0-9]+.[0-9]+.[0-9]+.[0-9]+", RELEASE)

    def test_release_notes_are_required(self):
        self.assertNotIn("--generate-notes", RELEASE)

    def test_confirm_input_guards_manual_release(self):
        self.assertIn("INPUT_CONFIRM", RELEASE)
        self.assertIn("Refusing to release", RELEASE)

    def test_windows_legs_smoke_test_the_installed_app(self):
        build = job_block(RELEASE, "build")
        self.assertIn("scripts/packaged_smoke_windows.py", build)
        self.assertLess(build.index("Build Windows installers"), build.index("packaged_smoke_windows.py"))
        self.assertIn("app/src-tauri/target/release/bundle/msi/*.msi", build)
        self.assertIn("app/src-tauri/target/release/bundle/nsis/*-setup.exe", build)

    def test_third_party_notices_are_written_per_target_and_merged(self):
        build = job_block(RELEASE, "build")
        publish = job_block(RELEASE, "publish")
        # Every leg records its own runtime; only the Linux leg reads the Rust graph.
        self.assertIn("scripts/third_party_notices.py", build)
        self.assertIn("--target \"$TRIPLE\"", build)
        self.assertIn("--cargo app/src-tauri", build)
        self.assertIn("name: third-party-notices-${{ matrix.triple }}", build)
        self.assertIn("pattern: third-party-notices-*", publish)
        self.assertIn("scripts/third_party_notices.py", publish)
        self.assertIn("--merge", publish)
        self.assertIn("THIRD-PARTY-NOTICES.txt LICENSE NOTICE", publish)
        self.assertLess(publish.index("Merge THIRD-PARTY-NOTICES"), publish.index("Stage the installers"))
        self.assertLess(publish.index("sha256sum -c SHA256SUMS"), publish.index("Publish the release"))

    def test_the_merge_expects_every_build_target(self):
        build = job_block(RELEASE, "build")
        publish = job_block(RELEASE, "publish")
        expect = publish[publish.index("--expect "):].split("\n", 1)[0]
        triples = set(re.findall(r"triple: (\S+)", build))
        self.assertEqual(len(triples), 5)
        self.assertEqual(set(expect.split()[1:]) - {"\\"}, triples)

    def test_the_apache_licence_and_notice_are_released_and_checksummed(self):
        publish = job_block(RELEASE, "publish")
        self.assertIn("cp LICENSE NOTICE", publish)
        self.assertIn("stage/LICENSE stage/NOTICE", publish)
        self.assertIn("sha256sum FlowMap_* THIRD-PARTY-NOTICES.txt LICENSE NOTICE", publish)
        self.assertIn("--pattern LICENSE --pattern NOTICE", publish)

    def test_the_font_licence_texts_are_released_and_checksummed(self):
        # The About panel and NOTICE point at these files, so each must be staged,
        # uploaded, listed in SHA256SUMS and re-downloaded for the byte check.
        publish = job_block(RELEASE, "publish")
        for name in ("LICENSE-inter.txt", "LICENSE-jetbrains-mono.txt"):
            with self.subTest(name=name):
                self.assertIn(f"client/src/assets/fonts/{name}", publish)
                self.assertIn(f"stage/{name}", publish)
                self.assertIn("sha256sum FlowMap_* THIRD-PARTY-NOTICES.txt LICENSE NOTICE", publish)
                self.assertIn(f"--pattern {name}", publish)
        sums = publish[publish.index("sha256sum FlowMap_*"):]
        self.assertIn("LICENSE-inter.txt LICENSE-jetbrains-mono.txt", sums[:200])

    def test_uv_and_rust_versions_are_pinned_once_per_workflow(self):
        # Every setup-uv step names the same exact release, and the Rust toolchain
        # is an exact version (no floating "stable").
        uv_version = re.search(r'UV_VERSION: "([^"]+)"', RELEASE)
        self.assertIsNotNone(uv_version)
        pinned = uv_version.group(1)
        for name in ("ci.yml", "release.yml", "windows-benchmark.yml", "macos-runtime-audit.yml",
                     "browser-diagnostics.yml"):
            lines = (ROOT / ".github/workflows" / name).read_text(encoding="utf-8").splitlines()
            uses = [i for i, line in enumerate(lines) if "astral-sh/setup-uv@" in line]
            with self.subTest(file=name):
                self.assertTrue(uses, f"{name} has no setup-uv step to pin")
            for i in uses:
                with self.subTest(file=name, line=i + 1):
                    block = "\n".join(lines[i:i + 3])
                    self.assertTrue(
                        "version: ${{ env.UV_VERSION }}" in block or f'version: "{pinned}"' in block,
                        f"{name}:{i + 1}: setup-uv is not pinned to {pinned}",
                    )
        self.assertRegex(RELEASE, r'RUST_TOOLCHAIN: "\d+\.\d+\.\d+"')
        self.assertIn("toolchain: ${{ env.RUST_TOOLCHAIN }}", RELEASE)
        audit = (ROOT / ".github/workflows/macos-runtime-audit.yml").read_text(encoding="utf-8")
        self.assertRegex(audit, r'toolchain: "\d+\.\d+\.\d+"')
        self.assertNotIn("toolchain: stable", audit)

    def test_the_rust_toolchain_is_pinned_in_ci_to_the_release_version(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        pinned = re.search(r'RUST_TOOLCHAIN: "(\d+\.\d+\.\d+)"', ci)
        self.assertIsNotNone(pinned, "ci.yml must pin RUST_TOOLCHAIN to an exact version")
        released = re.search(r'RUST_TOOLCHAIN: "([^"]+)"', RELEASE)
        self.assertEqual(pinned.group(1), released.group(1))
        # Every job that builds or audits the desktop shell (ubuntu, windows and macos)
        # installs that exact toolchain.
        install = "rustup toolchain install ${{ env.RUST_TOOLCHAIN }}"
        for job in ("shell", "shell-windows", "shell-macos", "dependency-audit"):
            with self.subTest(job=job):
                self.assertIn(install, job_block(ci, job))
        self.assertNotIn("toolchain: stable", ci)

    def test_a_published_release_is_never_rebuilt_or_overwritten(self):
        # The guard runs in prepare, which every build leg waits for, and it refuses
        # a release whose draft flag is false before any installer is built.
        prepare = job_block(RELEASE, "prepare")
        self.assertIn("gh release view", prepare)
        self.assertIn("--json isDraft", prepare)
        self.assertIn("Refusing to rebuild or overwrite", prepare)
        self.assertIn("needs: [prepare, gate]", job_block(RELEASE, "build"))
        self.assertIn("gh release view", job_block(RELEASE, "publish"))

    def test_version_fields_are_checked_by_the_shared_script(self):
        self.assertIn("scripts/check_release_versions.py", RELEASE)
        self.assertIn("scripts/check_release_versions.py", CI)

class CiWorkflowTests(unittest.TestCase):
    def test_push_runs_on_every_branch(self):
        self.assertIn('branches: ["**"]', CI)

    def test_only_pull_request_runs_are_superseded(self):
        self.assertIn("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", CI)

    def test_ci_is_reusable_by_the_release_gate(self):
        self.assertIn("workflow_call:", CI)

    def test_every_checkout_pins_the_verified_ref(self):
        checkouts = CI.count("uses: actions/checkout@")
        self.assertGreater(checkouts, 0)
        self.assertEqual(CI.count("ref: ${{ inputs.ref || github.sha }}"), checkouts)

    def test_windows_shell_and_rust_lints_run(self):
        self.assertIn("shell-windows:", CI)
        self.assertIn("runs-on: windows-latest", job_block(CI, "shell-windows"))
        shell = job_block(CI, "shell")
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", shell)
        self.assertIn("cargo fmt --check", shell)

    def test_windows_shell_runs_clippy_on_its_cfg_windows_code(self):
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", job_block(CI, "shell-windows"))

    def test_release_tooling_tests_run_in_ci(self):
        self.assertIn("unittest discover -s scripts", job_block(CI, "release-tooling"))

    def test_documentation_links_are_checked_in_ci(self):
        self.assertIn("scripts/check_doc_links.py", job_block(CI, "release-tooling"))

    def test_dmg_artwork_stamp_is_checked_in_ci(self):
        self.assertIn("scripts/check_dmg_art.py", job_block(CI, "release-tooling"))

    def test_css_font_size_ratchet_runs_in_the_client_job(self):
        self.assertIn("scripts/check_css_font_sizes.py", job_block(CI, "client"))

    def test_vendored_crocodile_wheel_is_unique_in_ci(self):
        self.assertIn("server/vendor/crocodile-*.whl", job_block(CI, "release-tooling"))

    def test_e2e_enforces_the_skip_and_flake_budget(self):
        self.assertIn("checkBudget.mjs", job_block(CI, "e2e"))
        self.assertTrue((ROOT / "client/tests/reporters/e2e-budget.json").is_file())

    def test_documentation_only_changes_still_run_ci(self):
        # A doc-only push or PR must reach the link check, so no trigger may skip paths.
        self.assertNotIn("paths-ignore", CI)
        self.assertIn("scripts/check_doc_links.py", job_block(CI, "release-tooling"))

    def test_ruff_runs_on_ubuntu_only_as_the_header_says(self):
        self.assertIn("ruff check", job_block(CI, "server"))
        self.assertNotIn("ruff", job_block(CI, "server-windows"))
        header = CI.split("\non:", 1)[0]
        self.assertIn("ruff lint and the mypy type gate", header)
        self.assertIn("(ubuntu only)", header)

    def test_mypy_type_gate_runs_on_the_server_job(self):
        self.assertIn("uv run mypy", job_block(CI, "server"))
        self.assertNotIn("mypy", job_block(CI, "server-windows"))

    def test_process_identifier_gate_runs_in_the_client_job(self):
        self.assertIn("scripts/check_process_comments.py", job_block(CI, "client"))

    def test_the_shell_clippy_and_fmt_header_matches_the_jobs(self):
        header = CI.split("\non:", 1)[0]
        self.assertIn("fmt (ubuntu only)", header)
        self.assertNotIn("cargo fmt", job_block(CI, "shell-windows"))

    def test_every_checkout_in_every_workflow_drops_the_token(self):
        for path in sorted((ROOT / ".github/workflows").glob("*.yml")):
            lines = path.read_text(encoding="utf-8").splitlines()
            for index, line in enumerate(lines):
                if "uses: actions/checkout@" not in line:
                    continue
                with self.subTest(file=path.name, line=index + 1):
                    self.assertIn("persist-credentials: false", "\n".join(lines[index:index + 4]))

    def test_the_macos_shell_runs_its_tests_and_clippy_in_ci(self):
        macos = job_block(CI, "shell-macos")
        self.assertIn("runs-on: macos-", macos)
        self.assertIn("cargo test --locked", macos)
        self.assertIn("cargo clippy --locked --all-targets -- -D warnings", macos)

    def test_the_bundling_pin_tests_run_in_the_release_tooling_job(self):
        self.assertIn("pytest app/scripts/tests", job_block(CI, "release-tooling"))

    def test_every_release_leg_smoke_tests_its_installer(self):
        build = job_block(RELEASE, "build")
        self.assertIn("scripts/packaged_smoke_posix.py", build)
        self.assertIn("app/src-tauri/target/release/bundle/dmg/*.dmg", build)
        self.assertIn("app/src-tauri/target/release/bundle/deb/*.deb", build)
        self.assertIn("app/src-tauri/target/release/bundle/appimage/*.AppImage", build)
        self.assertLess(build.index("Build Linux AppImage"), build.index("Smoke test the installed Linux apps"))
        self.assertLess(build.index("Build macOS installer"), build.index("Smoke test the installed macOS app"))

    def test_dependency_advisories_are_checked_in_ci(self):
        audit = job_block(CI, "dependency-audit")
        self.assertIn("npm audit --omit=dev --audit-level=high", audit)
        self.assertIn("pip-audit", audit)
        self.assertIn("uv export --frozen", audit)
        self.assertIn("cargo audit", audit)
        self.assertIn("cargo install cargo-audit --version", audit)

    def test_dependabot_covers_every_shipped_dependency_graph(self):
        config = (ROOT / ".github/dependabot.yml").read_text(encoding="utf-8")
        ecosystems = set(re.findall(r'package-ecosystem: "([^"]+)"', config))
        self.assertEqual(ecosystems, {"github-actions", "npm", "cargo", "uv"})

    def test_the_release_gate_runs_the_server_type_gate_through_ci(self):
        self.assertIn("uses: ./.github/workflows/ci.yml", job_block(RELEASE, "gate"))
        self.assertIn("uv run mypy", job_block(CI, "server"))


class BundledLicenceTests(unittest.TestCase):
    def test_the_bundled_notice_and_licence_match_the_root_copies(self):
        # The desktop bundle ships app/src-tauri/resources/{LICENSE,NOTICE}; they
        # must be the same bytes as the repository's licence files.
        for name in ("LICENSE", "NOTICE"):
            with self.subTest(name=name):
                self.assertEqual(
                    (ROOT / name).read_bytes(),
                    (ROOT / "app/src-tauri/resources" / name).read_bytes(),
                )

if __name__ == "__main__":
    unittest.main()
