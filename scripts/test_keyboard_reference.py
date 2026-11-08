"""The user guide's keyboard table must name every key the in-app overlay shows.

The overlay (`client/src/ui/keysheet.ts`, the `?` panel) is the code's list of
bindings. The guide's table is maintained by hand, so this test keeps it honest:
each single-key binding in KEYSHEET must appear, in backticks, in the guide's
"Keyboard & pointer reference" section. Gestures (words such as "drag" or
"wheel") and the arrow keys are described in prose rows and are not matched.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
KEYSHEET = (ROOT / "client/src/ui/keysheet.ts").read_text(encoding="utf-8")
GUIDE = (ROOT / "docs/user-guide.md").read_text(encoding="utf-8")
SECTION_TITLE = "## Keyboard & pointer reference"


def overlay_keys(source):
    """Every key label the overlay shows, split on ' / ' alternatives. A part is a
    key when it has a non-letter in it (`Ctrl+K`, `+`, `?`) or starts with a capital
    (`Space`, `E`); lower-case words are gesture names, not keys."""
    keys = []
    for label in re.findall(r"keys:\s*'([^']*)'", source):
        for part in (piece.strip() for piece in label.split(" / ")):
            if not part or " " in part:
                continue
            if not part.isalpha() or part[0].isupper():
                keys.append(part)
    return sorted(set(keys))


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

    def test_the_guide_no_longer_claims_the_overlay_hides_bindings(self):
        section = guide_section(GUIDE)
        self.assertNotIn("the overlay does not show yet", section)


if __name__ == "__main__":
    unittest.main()
