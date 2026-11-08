"""Checks that the DMG artwork renders from the app's own fonts and matches the release.

Run from the repository root with:
    python3 -m unittest discover -s app/scripts/tests -p "test_*.py"
"""

import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
APP = REPO / "app"
DMG = APP / "icons" / "dmg"
FONT_DIR = REPO / "client" / "src" / "assets" / "fonts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


class DmgArtTest(unittest.TestCase):
    def test_the_art_draws_its_text_with_the_fonts_the_app_ships(self):
        source = read(DMG / "make-bg.py")
        self.assertIn('"client" / "src" / "assets" / "fonts"', source)
        font_names = re.findall(r'"(jetbrains-mono-[^"]+\.woff2)"', source)
        self.assertEqual(
            len(font_names), 2, "make-bg.py names the regular and the bold face"
        )
        for name in font_names:
            self.assertTrue(
                (FONT_DIR / name).is_file(),
                f"{name} is missing from client/src/assets/fonts",
            )

    def test_the_art_needs_no_system_font(self):
        source = read(DMG / "make-bg.py")
        for system_path in ("/System/Library", "/Library/Fonts", "Menlo"):
            self.assertNotIn(
                system_path, source, f"{system_path} would make the render depend on the OS"
            )

    def test_the_rendered_art_is_stamped_with_the_release_version(self):
        version = json.loads(read(APP / "src-tauri" / "tauri.conf.json"))["version"]
        stamp = read(DMG / "RENDERED_VERSION").strip()
        self.assertEqual(stamp, version, "re-render the DMG art for the release version")

    def test_every_rendered_background_is_committed(self):
        for arch in ("aarch64", "x86_64"):
            for suffix in ("", "@2x"):
                self.assertTrue(
                    (DMG / f"bg-{arch}{suffix}.png").is_file(),
                    f"bg-{arch}{suffix}.png is missing",
                )


if __name__ == "__main__":
    unittest.main()
