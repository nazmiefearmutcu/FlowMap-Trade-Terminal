"""Fail when a relative Markdown link points at a missing file or a missing heading.

Checks every ``*.md`` file in the repository (or under ``--root``): a link to a
local file must name an existing file, and a ``#fragment`` must match a heading
in the target, using GitHub's anchor rules (lowercase, punctuation dropped,
spaces become hyphens, repeated headings get ``-1``, ``-2`` suffixes). Web links,
``mailto:`` links and links inside fenced code blocks are not checked.

Run from the repository root:  python3 scripts/check_doc_links.py
"""

import argparse
from pathlib import Path
import re
import sys
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", ".venv", "target", "dist", "__pycache__"}
LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def strip_fences(lines):
    """Yield (line_number, text) for lines outside fenced code blocks."""
    fenced = False
    for number, line in enumerate(lines, 1):
        if FENCE.match(line):
            fenced = not fenced
            continue
        if not fenced:
            yield number, line


def github_slug(heading):
    """GitHub's heading-to-anchor rule for one heading's visible text."""
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", heading)
    text = text.replace("`", "").strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors_of(path):
    """Return the set of anchors a Markdown file exposes."""
    seen = {}
    anchors = set()
    lines = path.read_text(encoding="utf-8").splitlines()
    for _, line in strip_fences(lines):
        match = HEADING.match(line)
        if not match:
            continue
        slug = github_slug(match.group(2))
        count = seen.get(slug, 0)
        anchors.add(slug if count == 0 else f"{slug}-{count}")
        seen[slug] = count + 1
    return anchors


def markdown_files(root):
    for path in sorted(root.rglob("*.md")):
        if SKIP_DIRS.intersection(path.relative_to(root).parts):
            continue
        yield path


def problems_in(root, path, anchor_cache):
    problems = []
    lines = path.read_text(encoding="utf-8").splitlines()
    for number, line in strip_fences(lines):
        for match in LINK.finditer(line):
            target = match.group(1)
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target) or target.startswith("//"):
                continue
            file_part, _, fragment = target.partition("#")
            file_part = unquote(file_part)
            if file_part:
                resolved = (path.parent / file_part).resolve()
                if not resolved.exists():
                    problems.append(f"{path.relative_to(root)}:{number}: missing file {target}")
                    continue
            else:
                resolved = path
            if fragment and resolved.suffix.lower() == ".md":
                if resolved not in anchor_cache:
                    anchor_cache[resolved] = anchors_of(resolved)
                if fragment not in anchor_cache[resolved]:
                    problems.append(f"{path.relative_to(root)}:{number}: missing anchor {target}")
    return problems


def check(root):
    root = Path(root).resolve()
    anchor_cache = {}
    problems = []
    for path in markdown_files(root):
        problems.extend(problems_in(root, path, anchor_cache))
    return problems


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args(argv)
    found = check(args.root)
    for message in found:
        print(message, file=sys.stderr)
    if found:
        print(f"{len(found)} broken documentation link(s).", file=sys.stderr)
        return 1
    print("All relative documentation links resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
