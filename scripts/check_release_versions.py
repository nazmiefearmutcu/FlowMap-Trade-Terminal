"""Fail when the nine version fields disagree with each other or with a tag.

Runs on every push and pull request (ci.yml), so version drift is caught on the
branch that produced it. The release workflow passes ``--tag`` to additionally
require that the tag names the same version.
"""

import argparse
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
TAG = re.compile(r"v[0-9]+\.[0-9]+\.[0-9]+")


def matched_version(root, path, pattern):
    match = re.search(pattern, (root / path).read_text(encoding="utf-8"))
    if match is None:
        raise ValueError(f"Missing version in {path}")
    return match.group(1)


def collect_versions(root=ROOT):
    """Return every version field, keyed by a human-readable location."""
    client_lock = json.loads((root / "client/package-lock.json").read_text(encoding="utf-8"))
    return {
        "Tauri": json.loads((root / "app/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"],
        "Cargo": matched_version(root, "app/src-tauri/Cargo.toml", r'(?m)^version = "([^"]+)"'),
        "Cargo lock": matched_version(root, "app/src-tauri/Cargo.lock", r'name = "flowmap"\s+version = "([^"]+)"'),
        "Client": json.loads((root / "client/package.json").read_text(encoding="utf-8"))["version"],
        "Client lock": client_lock["version"],
        "Client root lock": client_lock["packages"][""]["version"],
        "Server": matched_version(root, "server/pyproject.toml", r'(?m)^version = "([^"]+)"'),
        "Server lock": matched_version(root, "server/uv.lock", r'name = "flowmap-server"\s+version = "([^"]+)"'),
        "Server runtime": matched_version(root, "server/src/flowmap_server/__init__.py", r'__version__ = "([^"]+)"'),
    }


def changelog_problems(root, tag):
    """The tagged version's CHANGELOG.md heading must carry a date, not 'Unreleased'."""
    version = tag[1:]
    text = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    heading = re.search(rf"(?m)^## \[{re.escape(version)}\][^\n]*$", text)
    if heading is None:
        return [f"CHANGELOG.md has no '## [{version}]' heading for tag {tag}"]
    if "Unreleased" in heading.group(0):
        return [f"CHANGELOG.md still reads {heading.group(0).strip()!r}; date the {version} section when the tag is cut"]
    return []


def problems(versions, tag=None):
    """Return a list of human-readable problems; empty when everything agrees."""
    if tag is not None:
        if TAG.fullmatch(tag) is None:
            return [f"Invalid release tag {tag!r}: expected vX.Y.Z"]
        expected = tag[1:]
    else:
        expected = versions["Tauri"]
    wrong = {name: value for name, value in versions.items() if value != expected}
    if wrong:
        target = f"tag {tag}" if tag is not None else f"version {expected}"
        return [f"{target} expected; inconsistent versions: {wrong}"]
    return []


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="release tag that the versions must match")
    parser.add_argument("--root", type=Path, default=ROOT, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        versions = collect_versions(args.root)
        changelog = []
        if args.tag is not None and TAG.fullmatch(args.tag) is not None:
            changelog = changelog_problems(args.root, args.tag)
    except (OSError, ValueError, KeyError) as error:
        print(f"Version check failed: {error}", file=sys.stderr)
        return 1
    found = problems(versions, args.tag) + changelog
    for message in found:
        print(message, file=sys.stderr)
    if found:
        return 1
    print(f"All nine version fields agree ({versions['Tauri']})"
          + (f" and match {args.tag}" if args.tag else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
