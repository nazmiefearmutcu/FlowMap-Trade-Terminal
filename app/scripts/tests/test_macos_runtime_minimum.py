"""Tests for app/scripts/macos-runtime-minimum.py: the version parsing, the Mach-O
discovery and the load-command reading. The otool output is written out by hand,
so these run on any OS without Xcode.

Run from the repository root with:
    python3 -m unittest discover -s app/scripts/tests -p "test_*.py"
"""

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "macos-runtime-minimum.py"
spec = importlib.util.spec_from_file_location("macos_runtime_minimum", SCRIPT)
mrm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mrm)

MACHO_64_LITTLE = bytes.fromhex("cffaedfe") + b"\0" * 28


def build_version(minos: str, platform: str = "1") -> str:
    return (
        "Load command 0\n"
        "      cmd LC_BUILD_VERSION\n"
        "  cmdsize 32\n"
        f" platform {platform}\n"
        f"    minos {minos}\n"
        "      sdk 14.0\n"
    )


def version_min(version: str) -> str:
    return (
        "Load command 0\n"
        "      cmd LC_VERSION_MIN_MACOSX\n"
        "  cmdsize 16\n"
        f"  version {version}\n"
        "      sdk 10.15\n"
    )


def segment() -> str:
    return (
        "Load command 0\n"
        "      cmd LC_SEGMENT_64\n"
        "  cmdsize 72\n"
        "  segname __TEXT\n"
    )


class VersionTest(unittest.TestCase):
    def test_a_version_is_padded_to_three_parts(self):
        self.assertEqual(mrm.version("12"), (12, 0, 0))
        self.assertEqual(mrm.version("13.5"), (13, 5, 0))
        self.assertEqual(mrm.version("13.5.1"), (13, 5, 1))

    def test_a_malformed_version_is_refused(self):
        for value in ("", "a.b", "12..1", "1.2.3.4", ".5"):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                mrm.version(value)

    def test_the_patch_part_is_dropped_only_when_zero(self):
        self.assertEqual(mrm.version_string((12, 0, 0)), "12.0")
        self.assertEqual(mrm.version_string((13, 5, 0)), "13.5")
        self.assertEqual(mrm.version_string((13, 5, 1)), "13.5.1")


class MachoFilesTest(unittest.TestCase):
    def test_only_mach_o_files_are_collected(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = pathlib.Path(tmp)
            (runtime / "bin").mkdir()
            (runtime / "bin" / "python3").write_bytes(MACHO_64_LITTLE)
            (runtime / "lib").mkdir()
            (runtime / "lib" / "readme.txt").write_text("not a binary")
            found = mrm.macho_files(runtime)
            self.assertEqual([path.name for path in found], ["python3"])

    def test_a_runtime_without_mach_o_files_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / "notes.txt").write_text("text")
            with self.assertRaises(RuntimeError):
                mrm.macho_files(pathlib.Path(tmp))


class MinimumCommandsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.binary = pathlib.Path(self._tmp.name) / "python3"
        self.binary.write_bytes(MACHO_64_LITTLE)

    def tearDown(self):
        self._tmp.cleanup()

    def otool(self, *blocks: str) -> str:
        return f"{self.binary}:\n" + "".join(blocks)

    def test_build_version_gives_the_minos_of_a_macos_binary(self):
        records = mrm.minimum_commands(self.otool(build_version("13.0")), self.binary)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["command"], "LC_BUILD_VERSION")
        self.assertEqual(records[0]["minimum_version"], "13.0")
        self.assertEqual(records[0]["architecture"], "native")

    def test_version_min_macosx_gives_its_version(self):
        records = mrm.minimum_commands(self.otool(version_min("10.15")), self.binary)
        self.assertEqual(records[0]["command"], "LC_VERSION_MIN_MACOSX")
        self.assertEqual(records[0]["minimum_version"], "10.15")

    def test_other_load_commands_are_skipped(self):
        records = mrm.minimum_commands(
            self.otool(segment(), build_version("12.0")), self.binary
        )
        self.assertEqual([record["minimum_version"] for record in records], ["12.0"])

    def test_a_binary_without_a_minimum_is_refused(self):
        with self.assertRaises(RuntimeError):
            mrm.minimum_commands(self.otool(segment()), self.binary)

    def test_a_non_macos_build_platform_is_refused(self):
        # Platform 2 is iOS: a runtime built for another OS must not set the floor.
        with self.assertRaises(RuntimeError):
            mrm.minimum_commands(self.otool(build_version("13.0", platform="2")), self.binary)

    def test_a_missing_header_is_refused(self):
        with self.assertRaises(RuntimeError):
            mrm.minimum_commands("", self.binary)


if __name__ == "__main__":
    unittest.main()
