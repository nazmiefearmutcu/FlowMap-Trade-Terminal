"""Keep process identifiers out of the client's source and test comments.

Ticket, lane, swarm, campaign and contract identifiers describe how the
code was produced, not what it does. A reader of the shipped code cannot use
them, and they go stale. The audit trail lives in CHANGELOG.md and the issue
tracker. The server has the same rule in server/tests/test_process_comments.py.

Runs in the client job of ci.yml, on every push and pull request. The unit suite
(scripts/test_check_process_comments.py) runs the same scan over the repository.
"""

import argparse
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS = ("client/src", "client/tests")
SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html")

# The forms the server rule (server/tests/test_process_comments.py) catches that
# also occur in TypeScript, CSS and HTML: ticket ids, lane and campaign names,
# survey and gap ids, milestone and review codes, round, wave and goal numbers,
# QA codes, audit tags such as ``gl-19`` and swarm item labels. Domain words
# that merely look similar (``L2``, ``T0``, ``F10`` as a key name, ``lane`` in
# ordinary prose, ``SA`` as a ladder label, ``M2`` as SVG path data, a bare
# ``gap1`` in test data) do not match. scripts/test_check_process_comments.py
# pins this list against the server's alternatives.
PROCESS_ID = re.compile(
    r"FM-\d{3}"
    r"|\b[Ll]ane[ -][A-Z][A-Z0-9]{0,2}\b"
    r"|\b[Ll]ane-[A-Za-z0-9]+\b"
    r"|\b[Ss]warm\d*\b"
    r"|\b[Cc]ampaign\b"
    r"|\bNEEDS-[A-Z]+\b"
    r"|\bcontract C\d+\b"
    r"|\b[Ss]urvey-?\d"
    r"|\b[Gg]ap\d*-\d+\b"
    r"|\b(?:gl|ovl|core|api|trade)-\d{2}\b"
    r"|\bM\d(?: T\d+)?\b(?!\s*[-\d.,(])"
    r"|\bT[1-9]\d?\b"
    r"|\b[A-Z]\d-[A-Z]\d+\b"
    r"|\b[A-Z]\d-\d+\b"
    r"|\b[A-Z]-\d\b"
    r"|\b[Rr]ound[ -]?\d\b"
    r"|\b[Ww]ave[ -]?\d+\b"
    r"|\b[Ww]ave N\b"
    r"|\bGOAL \d\b"
    r"|\bF\d+/T\d+\b"
    r"|\bQA\d+\b"
    r"|\bF\d{2,3}\b"
    r"|\b[CDHR]\d\b"
    r"|\baudit FM\b"
    r"|\bSB item\b"
)


def offenders_in(text, name="<text>"):
    """``path:line: text`` for each line that carries a process identifier."""
    return [
        f"{name}:{number}: {line.strip()}"
        for number, line in enumerate(text.splitlines(), start=1)
        if PROCESS_ID.search(line)
    ]


def scan(root=ROOT, scan_dirs=SCAN_DIRS):
    """Every offending line under the scanned directories, sorted by path."""
    found = []
    for directory in scan_dirs:
        base = Path(root) / directory
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.suffix not in SOURCE_SUFFIXES:
                continue
            if "node_modules" in path.parts or "dist" in path.parts:
                continue
            relative = path.relative_to(root).as_posix()
            text = path.read_text(encoding="utf-8")
            found.extend(offenders_in(text, relative))
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    found = scan(args.root)
    # The console codepage may not encode every character a comment carries.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="backslashreplace")
    if found:
        print("Process identifiers in client comments (move the history to CHANGELOG.md):")
        for line in found:
            print(f"  {line}")
        return 1
    print("No process identifiers in client/src or client/tests.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
