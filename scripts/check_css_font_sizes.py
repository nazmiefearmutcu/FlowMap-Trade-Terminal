"""Ratchet on raw pixel font sizes in the client stylesheets.

ESLint reads only JavaScript and TypeScript, so the token rule in
client/eslint.config.js cannot see ``font-size: 12px`` written in a ``.css`` file.
This check counts those declarations under client/src. Every stylesheet has a
budget: the count it had when the gate was set. A stylesheet that is not listed
may contain none, and a listed one may not gain any. Moving a size to a font-size
token (src/theme) lowers the count; lower the budget here when that happens, so
the ratchet only tightens.

Runs in the client job of ci.yml, on every push and pull request.
"""

import argparse
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SCAN_DIR = "client/src"

# Declarations like ``font-size: 12px`` and ``font-size:.5px``. The lookbehind
# keeps ``--font-size`` custom properties and ``line-font-size`` names out.
PX_FONT_SIZE = re.compile(r"(?<![\w-])font-size\s*:\s*\d*\.?\d+px\b", re.IGNORECASE)

# Budgets at the time the gate was set (relative to the repository root).
BUDGETS = {
}


def count_px_font_sizes(text):
    """Number of raw pixel font-size declarations in one stylesheet."""
    return len(PX_FONT_SIZE.findall(text))


def scan(root=ROOT):
    """Map each stylesheet under client/src that has a raw px font size to its count."""
    counts = {}
    for path in sorted((root / SCAN_DIR).rglob("*.css")):
        found = count_px_font_sizes(path.read_text(encoding="utf-8"))
        if found:
            counts[path.relative_to(root).as_posix()] = found
    return counts


def problems(counts, budgets=BUDGETS):
    """One line per stylesheet that is over its budget, or new and unbudgeted."""
    lines = []
    for path, found in sorted(counts.items()):
        allowed = budgets.get(path, 0)
        if found > allowed:
            if allowed == 0:
                lines.append(
                    f"{path}: {found} raw px font size(s); use a font-size token from "
                    "src/theme instead"
                )
            else:
                lines.append(
                    f"{path}: {found} raw px font sizes, budget {allowed}; "
                    "use a font-size token from src/theme instead"
                )
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    counts = scan(args.root)
    lines = problems(counts)
    if lines:
        for line in lines:
            print(f"check_css_font_sizes: {line}", file=sys.stderr)
        return 1
    total = sum(counts.values())
    print(
        f"check_css_font_sizes: {total} raw px font size(s) in {len(counts)} stylesheet(s), "
        "all within budget"
    )
    shrunk = sorted(
        path for path, allowed in BUDGETS.items() if counts.get(path, 0) < allowed
    )
    for path in shrunk:
        print(
            f"check_css_font_sizes: note: {path} is under its budget "
            f"({counts.get(path, 0)} < {BUDGETS[path]}); lower the budget in this script"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
