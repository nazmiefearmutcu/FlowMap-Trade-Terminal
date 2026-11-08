"""Fail when the committed DMG artwork was rendered for a different app version.

``app/icons/dmg/RENDERED_VERSION`` records the version that ``make-bg.py`` last
rendered into the background PNGs. The subtitle on the disk image carries that
version, so a stale stamp ships the wrong number to users. The release workflow
used to re-render the artwork on the macOS runner with an unpinned Pillow; it now
only verifies the stamp, and this check is the gate that keeps the committed art
current. Runs on every push and pull request (ci.yml, release-tooling) and in the
macOS build legs (release.yml).

Fix a failure by rendering the art on a machine with Pillow and committing it:

    python3 app/icons/dmg/make-bg.py <version> --all
"""

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
TAURI_CONF = "app/src-tauri/tauri.conf.json"
STAMP = "app/icons/dmg/RENDERED_VERSION"


def app_version(root=ROOT):
    """The version the desktop app is built as (tauri.conf.json)."""
    return json.loads((root / TAURI_CONF).read_text(encoding="utf-8"))["version"]


def rendered_version(root=ROOT):
    """The version stamped into the committed DMG artwork, or None if absent."""
    path = root / STAMP
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8").strip()


def mismatch(root=ROOT):
    """Return a one-line complaint when the artwork is stale, else None."""
    expected = app_version(root)
    stamped = rendered_version(root)
    if stamped is None:
        return f"{STAMP} is missing; render with `python3 app/icons/dmg/make-bg.py {expected} --all`"
    if stamped != expected:
        return (
            f"DMG artwork is rendered for {stamped!r} but the app version is {expected!r}; "
            f"render it with `python3 app/icons/dmg/make-bg.py {expected} --all` and commit {STAMP}"
        )
    return None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    problem = mismatch(args.root)
    if problem is not None:
        print(f"check_dmg_art: {problem}", file=sys.stderr)
        return 1
    print(f"check_dmg_art: DMG artwork matches app version {app_version(args.root)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
