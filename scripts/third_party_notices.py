"""Write THIRD-PARTY-NOTICES.txt for a release, from what the build installed.

Nothing is fetched and nothing is guessed:

- Python packages come from the ``*.dist-info/METADATA`` files in the bundled
  runtime's site-packages (the packages the installers really ship).
- Client packages come from ``client/package-lock.json``: every entry that is not
  a dev-only dependency, with the version and licence from the installed
  ``package.json`` next to it.
- Rust crates come from ``cargo metadata --locked`` for the desktop shell: every
  registry or git crate in its locked graph (build and platform-specific crates
  included, so the list can be wider than what one platform links).

- The web fonts are listed with the full SIL Open Font License texts found beside
  them (``client/src/assets/fonts/LICENSE-*.txt``), because the OFL requires the
  licence to travel with the font.

A package that declares no licence is written as ``UNKNOWN``. The merge refuses
to write a release that carries an ``UNKNOWN`` entry, unless that exact
``name@version`` is listed, with a reason, in
``scripts/third_party_unknown_allowlist.txt`` (a reviewed exception).

Release builds run this once per target (``--target``), each leg reading the
runtime it really bundles, and then once more (``--merge``) to write the one
THIRD-PARTY-NOTICES.txt that is published. The merge refuses a release whose
targets are not all present.
"""

import argparse
import email
import json
from dataclasses import asdict, dataclass
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
UNKNOWN = "UNKNOWN"
NOTICE_FILE = "THIRD-PARTY-NOTICES.txt"
FONT_DIR = ROOT / "client" / "src" / "assets" / "fonts"
UNKNOWN_ALLOWLIST = ROOT / "scripts" / "third_party_unknown_allowlist.txt"
PART_FORMAT = "flowmap-third-party-part/1"
# FlowMap's own server distribution is covered by LICENSE and NOTICE, not listed here.
FIRST_PARTY = {"flowmap-server"}


@dataclass(frozen=True)
class Component:
    name: str
    version: str
    license: str


@dataclass(frozen=True)
class FontLicence:
    name: str
    text: str


# Display names for the licence files' slugs; an unlisted font falls back to title case.
FONT_NAMES = {"inter": "Inter", "jetbrains-mono": "JetBrains Mono", "pixelify-sans": "Pixelify Sans"}


def font_licences(fonts_dir):
    """The licence texts shipped beside the bundled web fonts, sorted by file name.
    A licence that is not valid UTF-8 is refused rather than silently altered."""
    licences = []
    for path in sorted(fonts_dir.glob("LICENSE-*.txt")):
        slug = path.stem[len("LICENSE-"):]
        name = FONT_NAMES.get(slug, slug.replace("-", " ").title())
        text = path.read_text(encoding="utf-8").strip()
        if not text:
            raise ValueError(f"empty font licence text: {path}")
        licences.append(FontLicence(name, text))
    if not licences:
        raise ValueError(f"no font licence texts (LICENSE-*.txt) found in {fonts_dir}")
    return licences


def find_site_packages(runtime):
    """The site-packages folders of a bundled runtime (Windows and Unix layouts)."""
    candidates = [runtime / "Lib" / "site-packages", *sorted(runtime.glob("lib/python*/site-packages"))]
    found = [path for path in candidates if path.is_dir()]
    if not found:
        raise FileNotFoundError(f"no site-packages under {runtime}")
    return found


def _classifier_license(classifiers):
    names = [
        value.split("::")[-1].strip()
        for value in classifiers
        if value.startswith("License ::") and value.split("::")[-1].strip()
    ]
    return "; ".join(dict.fromkeys(names)) if names else None


def python_license(metadata):
    """The declared licence of one distribution, from its parsed METADATA headers."""
    expression = (metadata.get("License-Expression") or "").strip()
    if expression:
        return expression
    declared = (metadata.get("License") or "").strip()
    # Some projects paste the whole licence text into this field; only a short
    # one-line value is a licence name.
    if declared and declared != UNKNOWN and "\n" not in declared and len(declared) <= 120:
        return declared
    return _classifier_license(metadata.get_all("Classifier") or []) or UNKNOWN


def python_components(site_packages):
    """Every installed distribution in the given site-packages folders, sorted."""
    seen = {}
    for site in site_packages:
        for metadata_file in sorted(site.glob("*.dist-info/METADATA")):
            metadata = email.message_from_string(metadata_file.read_text(encoding="utf-8", errors="replace"))
            name = (metadata.get("Name") or metadata_file.parent.name).strip()
            if name.casefold() in FIRST_PARTY:
                continue
            version = (metadata.get("Version") or "").strip() or UNKNOWN
            seen.setdefault((name.casefold(), version), Component(name, version, python_license(metadata)))
    return sorted(seen.values(), key=lambda item: (item.name.casefold(), item.version))


def _npm_license(package_json):
    value = package_json.get("license")
    if isinstance(value, dict):
        value = value.get("type")
    if not value and isinstance(package_json.get("licenses"), list):
        value = "; ".join(
            str(item.get("type", "")) for item in package_json["licenses"] if isinstance(item, dict)
        )
    return str(value).strip() if value else UNKNOWN


def npm_components(client):
    """Production client packages from the lock file, with licences from node_modules."""
    lock = json.loads((client / "package-lock.json").read_text(encoding="utf-8"))
    components = []
    for key, entry in sorted(lock.get("packages", {}).items()):
        if not key or entry.get("dev") or entry.get("devOptional"):
            continue
        name = key.rsplit("node_modules/", 1)[-1]
        installed = client / key
        package_file = installed / "package.json"
        version = str(entry.get("version") or UNKNOWN)
        license_name = UNKNOWN
        if package_file.is_file():
            package_json = json.loads(package_file.read_text(encoding="utf-8"))
            version = str(package_json.get("version") or version)
            license_name = _npm_license(package_json)
        components.append(Component(name, version, license_name))
    return sorted(components, key=lambda item: (item.name.casefold(), item.version))


def cargo_components(metadata):
    """Every registry or git crate in a `cargo metadata` document, sorted. Path
    crates are first-party code and are left out."""
    items = {}
    for package in metadata.get("packages", []):
        if not package.get("source"):
            continue
        name = str(package.get("name") or "").strip()
        if not name or name.casefold() in FIRST_PARTY:
            continue
        version = str(package.get("version") or UNKNOWN)
        license_name = str(package.get("license") or "").strip() or UNKNOWN
        items.setdefault((name.casefold(), version), Component(name, version, license_name))
    return sorted(items.values(), key=lambda item: (item.name.casefold(), item.version))


def read_cargo_metadata(crate_dir):
    """The locked dependency graph of the crate in `crate_dir`. Needs `cargo` on PATH."""
    completed = subprocess.run(
        ["cargo", "metadata", "--format-version", "1", "--locked",
         "--manifest-path", str(crate_dir / "Cargo.toml")],
        capture_output=True,
        # cargo writes UTF-8 whatever the console code page is (Windows Turkish: cp1254).
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if completed.returncode != 0:
        raise ValueError(f"cargo metadata failed: {completed.stderr.strip()}")
    return json.loads(completed.stdout)


def _header(version):
    return [
        f"FlowMap {version} - third-party notices",
        "",
        "Generated by scripts/third_party_notices.py from the packages this release",
        "installs. Each component remains under its own licence; the licence texts",
        "ship inside the installed packages. Entries marked UNKNOWN declare no licence",
        "and must be checked before the release is published.",
    ]


def _component_lines(items):
    return [f"- {item.name} {item.version} - {item.license}" for item in items]


def _font_lines(fonts):
    lines = []
    for font in fonts:
        lines += ["", f"--- {font.name} (SIL Open Font License) ---", font.text]
    return lines


def render(version, python_items, npm_items, cargo_items=None, fonts=None):
    """The notices file text: a header, then one line per component. The Rust
    section appears only when the crate graph was read (`cargo_items` given), and
    the font licences only when `fonts` is given."""
    lines = _header(version)
    lines += ["", f"Python packages in the bundled runtime ({len(python_items)})"]
    lines += _component_lines(python_items)
    lines += ["", f"Client packages bundled in the web app ({len(npm_items)})"]
    lines += _component_lines(npm_items)
    if fonts is not None:
        lines += ["", f"Fonts bundled in the web app ({len(fonts)})"]
        lines += _font_lines(fonts)
    if cargo_items is not None:
        lines += ["", f"Rust crates of the desktop shell ({len(cargo_items)})"]
        lines += _component_lines(cargo_items)
    return "\n".join(lines) + "\n"


def part_document(target, python_items, npm_items, cargo_items, fonts):
    """One release target's share of the notices, as JSON for `merge_parts`. The
    Rust crate graph is present only in the part of the leg that read it."""
    return {
        "format": PART_FORMAT,
        "target": target,
        "python": [asdict(item) for item in python_items],
        "npm": [asdict(item) for item in npm_items],
        "cargo": None if cargo_items is None else [asdict(item) for item in cargo_items],
        "fonts": [{"name": font.name, "text": font.text} for font in fonts],
    }


def merge_parts(version, parts, expected_targets):
    """The published notices text from every target's part. Refuses a release whose
    targets are not exactly the expected set, and needs exactly one part that
    carries the Rust crate graph (the Linux leg); the client and font lists come
    from that same part."""
    by_target = {}
    for part in parts:
        if part.get("format") != PART_FORMAT:
            raise ValueError(f"not a third-party notices part: {part.get('target', '?')}")
        if part["target"] in by_target:
            raise ValueError(f"duplicate notices part for {part['target']}")
        by_target[part["target"]] = part
    missing = [target for target in expected_targets if target not in by_target]
    if missing:
        raise ValueError("missing notices part for " + ", ".join(missing))
    unexpected = [target for target in by_target if target not in expected_targets]
    if unexpected:
        raise ValueError("unexpected notices part for " + ", ".join(unexpected))
    shared = [part for part in by_target.values() if part["cargo"] is not None]
    if len(shared) != 1:
        raise ValueError(f"exactly one part must carry the Rust crate graph, found {len(shared)}")
    shared = shared[0]

    lines = _header(version)
    for target in expected_targets:
        python_items = [Component(**item) for item in by_target[target]["python"]]
        lines += ["", f"Python packages in the bundled runtime for {target} ({len(python_items)})"]
        lines += _component_lines(python_items)
    npm_items = [Component(**item) for item in shared["npm"]]
    lines += ["", f"Client packages bundled in the web app ({len(npm_items)})"]
    lines += _component_lines(npm_items)
    fonts = [FontLicence(**font) for font in shared["fonts"]]
    lines += ["", f"Fonts bundled in the web app ({len(fonts)})"]
    lines += _font_lines(fonts)
    cargo_items = [Component(**item) for item in shared["cargo"]]
    lines += ["", f"Rust crates of the desktop shell ({len(cargo_items)})"]
    lines += _component_lines(cargo_items)
    return "\n".join(lines) + "\n"


def unknown_count(*groups):
    return sum(1 for group in groups for item in group if item.license == UNKNOWN)


def load_unknown_allowlist(path):
    """The reviewed ``name@version`` exceptions: one per line, ``#`` starts a comment."""
    entries = set()
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        entry = raw.split("#", 1)[0].strip()
        if entry:
            entries.add(entry)
    return entries


def unlisted_unknowns(parts, allowed):
    """Sorted ``name@version`` of every part component with no declared licence that
    the reviewed allow-list does not name."""
    found = set()
    for part in parts:
        for group in ("python", "npm", "cargo"):
            for item in part[group] or []:
                if item["license"] == UNKNOWN:
                    key = f"{item['name']}@{item['version']}"
                    if key not in allowed:
                        found.add(key)
    return sorted(found)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--runtime", type=Path, default=None,
                        help="the bundled runtime folder (app/src-tauri/resources/pyruntime); required unless --merge")
    parser.add_argument("--client", type=Path, default=ROOT / "client",
                        help="the client folder holding package-lock.json and node_modules")
    parser.add_argument("--version", required=True, help="the release version, for the header")
    parser.add_argument("--cargo", type=Path, default=None,
                        help="the desktop shell's crate folder (app/src-tauri); its locked Rust crates are listed too")
    parser.add_argument("--fonts", type=Path, default=FONT_DIR,
                        help="the folder holding the font licence texts (LICENSE-*.txt)")
    parser.add_argument("--target", default=None,
                        help="write this release target's part as JSON (for --merge) instead of the notices text")
    parser.add_argument("--merge", type=Path, nargs="+", metavar="PART", default=None,
                        help="merge the per-target JSON parts into the notices text at --out")
    parser.add_argument("--expect", nargs="+", metavar="TARGET", default=None,
                        help="with --merge: every release target that must have a part")
    parser.add_argument("--out", type=Path, default=Path(NOTICE_FILE))
    parser.add_argument("--allow-unknown", type=Path, default=UNKNOWN_ALLOWLIST,
                        help="with --merge: the reviewed name@version list of packages with no declared licence")
    args = parser.parse_args(argv)
    try:
        if args.merge is not None:
            if not args.expect:
                parser.error("--merge needs --expect with the release targets")
            parts = [json.loads(path.read_text(encoding="utf-8")) for path in args.merge]
            text = merge_parts(args.version, parts, args.expect)
            unlisted = unlisted_unknowns(parts, load_unknown_allowlist(args.allow_unknown))
            if unlisted:
                print("third_party_notices: refusing the release, these packages declare no licence "
                      f"and are not in {args.allow_unknown}: {', '.join(unlisted)}", file=sys.stderr)
                return 1
            args.out.write_text(text, encoding="utf-8", newline="\n")
            unknown = sum(1 for part in parts for group in ("python", "npm", "cargo")
                          for item in (part[group] or []) if item["license"] == UNKNOWN)
            print(f"third_party_notices: merged {len(parts)} target parts into {args.out} "
                  f"({unknown} with no declared licence, all reviewed)")
            return 0
        if args.runtime is None:
            parser.error("--runtime is required unless --merge is given")
        python_items = python_components(find_site_packages(args.runtime))
        npm_items = npm_components(args.client)
        cargo_items = None
        if args.cargo is not None:
            cargo_items = cargo_components(read_cargo_metadata(args.cargo))
        fonts = font_licences(args.fonts)
    except (OSError, ValueError, KeyError) as error:
        print(f"third_party_notices: {error}", file=sys.stderr)
        return 1
    if args.target is not None:
        document = part_document(args.target, python_items, npm_items, cargo_items, fonts)
        args.out.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8", newline="\n")
        print(f"third_party_notices: wrote the {args.target} part to {args.out} "
              f"({len(python_items)} Python, {len(npm_items)} client packages, "
              f"{unknown_count(python_items, npm_items, cargo_items or ())} with no declared licence)")
        return 0
    args.out.write_text(render(args.version, python_items, npm_items, cargo_items, fonts),
                        encoding="utf-8", newline="\n")
    unknown = unknown_count(python_items, npm_items, cargo_items or ())
    crates = "" if cargo_items is None else f", {len(cargo_items)} Rust crates"
    print(f"third_party_notices: wrote {args.out} ({len(python_items)} Python, "
          f"{len(npm_items)} client packages, {len(fonts)} font licences{crates}, "
          f"{unknown} with no declared licence)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
