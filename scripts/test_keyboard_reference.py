"""The user guide's keyboard table must name every key the in-app overlay shows.

The overlay (`client/src/ui/keysheet.ts`, the `?` panel) is the code's list of
bindings. The guide's table is maintained by hand, so this test checks it both
ways against the overlay:

- every key the overlay shows (single keys, chords such as `Ctrl+K`, the arrow
  keys and the `+ / −` and `] / [` pairs) appears in backticks in the guide's
  "Keyboard & pointer reference" section;
- every key in the first column of the guide's table is one the overlay shows,
  so a removed or renamed binding cannot linger in the guide.

Gestures (words such as "drag" or "wheel") are described in prose and are not
matched. The modifiers `Shift` and `Ctrl` appear in the guide's gesture rows only.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
KEYSHEET = (ROOT / "client/src/ui/keysheet.ts").read_text(encoding="utf-8")
GUIDE = (ROOT / "docs/user-guide.md").read_text(encoding="utf-8")
SECTION_TITLE = "## Keyboard & pointer reference"
ARROWS = ("←", "→", "↑", "↓")
# Modifiers the guide names inside gesture rows ("`Shift`/`Ctrl` + wheel").
MODIFIERS = {"Shift", "Ctrl"}


def overlay_keys(source):
    """Every key label the overlay shows, split on ' / ' alternatives. A part is a
    key when it has a non-letter in it (`Ctrl+K`, `+`, `?`) or starts with a capital
    (`Space`, `E`); lower-case words are gesture names, not keys. A part made only of
    arrow glyphs (`← → ↑ ↓`) is a row of arrow keys."""
    keys = []
    for label in re.findall(r"keys:\s*'([^']*)'", source):
        for part in (piece.strip() for piece in label.split(" / ")):
            if not part:
                continue
            words = part.split()
            if words and all(word in ARROWS for word in words):
                keys.extend(words)
            elif " " in part:
                continue
            elif not part.isalpha() or part[0].isupper():
                keys.append(part)
    return sorted(set(keys))


def guide_table_keys(section):
    """The keys named in the first column of the guide's table rows."""
    keys = set()
    for line in section.splitlines():
        if line.startswith("| `"):
            keys.update(re.findall(r"`([^`]+)`", line.split("|")[1]))
    return keys


def guide_section(text):
    start = text.index(SECTION_TITLE)
    end = text.find("\n## ", start + len(SECTION_TITLE))
    return text[start:] if end == -1 else text[start:end]


class KeyboardReferenceTests(unittest.TestCase):
    def test_the_overlay_has_keys_to_check(self):
        keys = overlay_keys(KEYSHEET)
        self.assertIn("Space", keys)
        self.assertIn("Shift+P", keys)
        self.assertIn("Ctrl+K", keys)
        self.assertNotIn("drag", keys)

    def test_every_overlay_key_is_named_in_the_guide_table(self):
        section = guide_section(GUIDE)
        missing = [key for key in overlay_keys(KEYSHEET) if f"`{key}`" not in section]
        self.assertEqual(missing, [], "keys shown by the overlay but missing from docs/user-guide.md")

    def test_every_arrow_key_of_the_overlay_is_named_in_the_guide(self):
        section = guide_section(GUIDE)
        for arrow in ARROWS:
            with self.subTest(arrow=arrow):
                self.assertIn(arrow, overlay_keys(KEYSHEET))
                self.assertIn(f"`{arrow}`", section)

    def test_every_key_in_the_guide_table_is_one_the_overlay_shows(self):
        overlay = set(overlay_keys(KEYSHEET))
        stale = sorted(
            key for key in guide_table_keys(guide_section(GUIDE))
            if key not in overlay and key not in MODIFIERS
        )
        self.assertEqual(stale, [], "guide table names keys the overlay does not show")

    def test_the_guide_no_longer_claims_the_overlay_hides_bindings(self):
        section = guide_section(GUIDE)
        self.assertNotIn("the overlay does not show yet", section)


if __name__ == "__main__":
    unittest.main()
