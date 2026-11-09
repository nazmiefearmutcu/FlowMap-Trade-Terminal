"""Size ratchet for the WebGL modules under client/src/gl.

A module that is not listed in CEILINGS may hold at most LIMIT lines. A listed
module may not grow past its ceiling, which is the length it had when the gate
was set. Lower a ceiling when the module is split; a ceiling is never raised to
let a change through. Test files and declaration files are not counted.

Runs in the client job of ci.yml, on every push and pull request.
"""

import argparse
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SCAN_DIR = "client/src/gl"
LIMIT = 600

# Modules over LIMIT when the gate was set. renderer.ts keeps its size on purpose:
# its delegates are the API the app and the e2e test hooks call, so splitting it
# would move that surface rather than shrink it.
CEILINGS = {
    "client/src/gl/heatmapMath.ts": 710,
    "client/src/gl/overlays/manager.ts": 620,
    "client/src/gl/camera.ts": 767,
    "client/src/gl/shaders/heatmap.ts": 823,
    "client/src/gl/normalize.ts": 881,
    "client/src/gl/renderer.ts": 1086,
    "client/src/gl/heatmap.ts": 649,
}


def line_counts(root=ROOT):
    """Number of lines in each counted module under client/src/gl."""
    counts = {}
    for path in sorted((root / SCAN_DIR).rglob("*.ts")):
        if path.name.endswith((".test.ts", ".d.ts")):
            continue
        text = path.read_text(encoding="utf-8")
        counts[path.relative_to(root).as_posix()] = len(text.splitlines())
    return counts


def problems(counts, ceilings=CEILINGS, limit=LIMIT):
    """One line per module over its limit or ceiling, and per stale ceiling entry."""
    lines = []
    for path, found in sorted(counts.items()):
        if path in ceilings:
            if found > ceilings[path]:
                lines.append(
                    f"{path}: {found} lines, ceiling {ceilings[path]}; split the module "
                    "instead of growing it"
                )
        elif found > limit:
            lines.append(f"{path}: {found} lines, limit {limit}; split it into modules")
    for path in sorted(ceilings):
        if path not in counts:
            lines.append(f"{path}: listed in CEILINGS but not found; remove the entry")
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    counts = line_counts(args.root)
    lines = problems(counts)
    if lines:
        for line in lines:
            print(f"check_gl_file_sizes: {line}", file=sys.stderr)
        return 1
    print(f"check_gl_file_sizes: {len(counts)} module(s) within the size ratchet")
    for path, ceiling in sorted(CEILINGS.items()):
        found = counts.get(path)
        if found is not None and found < ceiling:
            print(f"check_gl_file_sizes: note: {path} is under its ceiling ({found} < {ceiling}); lower it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
