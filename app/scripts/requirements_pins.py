#!/usr/bin/env python3
"""Pin edits and hash checks for the requirements file bundle-python.sh installs.

  requirements_pins.py win-arm64 REQS      apply the Windows-on-ARM exceptions in place
  requirements_pins.py check-hashes REQS   fail unless every requirement carries a --hash

`uv export` writes each requirement as a column-0 line followed by indented
continuation lines (`--hash=sha256:...` entries and `# via` comments). Each such
block is one entry and is kept, dropped or rewritten as a unit.

Stdlib only: this runs on the bundled interpreter before any package is installed.
"""

import re
import sys
from pathlib import Path

# Packages the win-arm64 runtime does not ship (see bundle-python.sh, step 3b).
DROP = ("pyarrow", "zlib-ng", "aiohttp-fast-zlib")

# name -> (locked version, pinned version, sha256 of every PyPI file for the pinned
# version). The digests are the ones PyPI publishes for cryptography 46.0.3; uv.lock
# records only the locked 49.0.0, so the pin is verified by these values instead.
REPIN = {
    "cryptography": (
        "49.0.0",
        "46.0.3",
        (
            "00a5e7e87938e5ff9ff5447ab086a5706a957137e6e433841e9d24f38a065217",
            "01ca9ff2885f3acc98c29f1860552e37f6d7c7d013d7334ff2a9de43a449315d",
            "09859af8466b69bc3c27bdf4f5d84a665e0f7ab5088412e9e2ec49758eca5cbc",
            "0abf1ffd6e57c67e92af68330d05760b7b7efb243aab8377e583284dbab72c71",
            "1000713389b75c449a6e979ffc7dcc8ac90b437048766cef052d4d30b8220971",
            "109d4ddfadf17e8e7779c39f9b18111a09efb969a301a31e987416a0191ed93a",
            "10b01676fc208c3e6feeb25a8b83d81767e8059e1fe86e1dc62d10a3018fa926",
            "10ca84c4668d066a9878890047f03546f3ae0a6b8b39b697457b7757aaf18dbc",
            "15ab9b093e8f09daab0f2159bb7e47532596075139dd74365da52ecc9cb46c5d",
            "191bb60a7be5e6f54e30ba16fdfae78ad3a342a0599eb4193ba88e3f3d6e185b",
            "22d7e97932f511d6b0b04f2bfd818d73dcd5928db509460aaf48384778eb6d20",
            "23b1a8f26e43f47ceb6d6a43115f33a5a37d57df4ea0ca295b780ae8546e8044",
            "36e627112085bb3b81b19fed209c05ce2a52ee8b15d161b7c643a7d5a88491f3",
            "39b6755623145ad5eff1dab323f4eae2a32a77a7abef2c5089a04a3d04366715",
            "3b51b8ca4f1c6453d8829e1eb7299499ca7f313900dd4d89a24b8b87c0a780d4",
            "402b58fc32614f00980b66d6e56a5b4118e6cb362ae8f3fda141ba4689bd4506",
            "416260257577718c05135c55958b674000baef9a1c7d9e8f306ec60d71db850f",
            "46acf53b40ea38f9c6c229599a4a13f0d46a6c3fa9ef19fc1a124d62e338dfa0",
            "4b7387121ac7d15e550f5cb4a43aef2559ed759c35df7336c402bb8275ac9683",
            "50fc3343ac490c6b08c0cf0d704e881d0d660be923fd3076db3e932007e726e3",
            "516ea134e703e9fe26bcd1277a4b59ad30586ea90c365a87781d7887a646fe21",
            "549e234ff32571b1f4076ac269fcce7a808d3bf98b76c8dd560e42dbc66d7d91",
            "5d7f93296ee28f68447397bf5198428c9aeeab45705a55d53a6343455dcb2c3c",
            "5ecfccd2329e37e9b7112a888e76d9feca2347f12f37918facbb893d7bb88ee8",
            "6276eb85ef938dc035d59b87c8a7dc559a232f954962520137529d77b18ff1df",
            "6b5063083824e5509fdba180721d55909ffacccc8adbec85268b48439423d78c",
            "6eae65d4c3d33da080cff9c4ab1f711b15c1d9760809dad6ea763f3812d254cb",
            "6f61efb26e76c45c4a227835ddeae96d83624fb0d29eb5df5b96e14ed1a0afb7",
            "71e842ec9bc7abf543b47cf86b9a743baa95f4677d22baa4c7d5c69e49e9bc04",
            "760f83faa07f8b64e9c33fc963d790a2edb24efb479e3520c14a45741cd9b2db",
            "78a97cf6a8839a48c49271cdcbd5cf37ca2c1d6b7fdd86cc864f302b5e9bf459",
            "7ce938a99998ed3c8aa7e7272dca1a610401ede816d36d0693907d863b10d9ea",
            "8a6e050cb6164d3f830453754094c086ff2d0b2f3a897a1d9820f6139a1f0914",
            "9394673a9f4de09e28b5356e7fff97d778f8abad85c9d5ac4a4b7e25a0de7717",
            "94cd0549accc38d1494e1f8de71eca837d0509d0d44bf11d158524b0e12cebf9",
            "a04bee9ab6a4da801eb9b51f1b708a1b5b5c9eb48c03f74198464c66f0d344ac",
            "a23582810fedb8c0bc47524558fb6c56aac3fc252cb306072fd2815da2a47c32",
            "a2c0cd47381a3229c403062f764160d57d4d175e022c1df84e168c6251a22eec",
            "a8b17438104fed022ce745b362294d9ce35b4c2e45c1d958ad4a4b019285f4a1",
            "a9a3008438615669153eb86b26b61e09993921ebdd75385ddd748702c5adfddb",
            "b02cf04496f6576afffef5ddd04a0cb7d49cf6be16a9059d793a30b035f6b6ac",
            "b419ae593c86b87014b9be7396b385491ad7f320bde96826d0dd174459e54665",
            "c0a7bb1a68a5d3471880e264621346c48665b3bf1c3759d682fc0864c540bd9e",
            "c70cc23f12726be8f8bc72e41d5065d77e4515efae3690326764ea1b07845cfb",
            "c8daeb2d2174beb4575b77482320303f3d39b8e81153da4f0fb08eb5fe86a6c5",
            "cb3d760a6117f621261d662bccc8ef5bc32ca673e037c83fbe565324f5c46936",
            "d55f3dffadd674514ad19451161118fd010988540cee43d8bc20675e775925de",
            "d89c3468de4cdc4f08a57e214384d0471911a3830fcdaf7a8cc587e42a866372",
            "db391fa7c66df6762ee3f00c95a89e6d428f4d60e7abc8328f4fe155b5ac6e54",
            "dfb781ff7eaa91a6f7fd41776ec37c5853c795d3b358d4896fdbb5df168af422",
            "e5bf0ed4490068a2e72ac03d786693adeb909981cc596425d09032d372bcc849",
            "e7aec276d68421f9574040c26e2a7c3771060bc0cff408bae1dcb19d3ab1e63c",
            "ef639cb3372f69ec44915fafcd6698b6cc78fbe0c2ea41be867f6ed612811963",
            "f260d0d41e9b4da1ed1e0f1ce571f97fe370b152ab18778e9e8f67d6af432018",
        ),
    ),
}

REQUIREMENT = re.compile(r"^([A-Za-z0-9._-]+)\s*(==|@)")


def split_entries(lines: list[str]) -> list[list[str]]:
    """Group lines into entries: a column-0 line and the indented lines after it.

    Column-0 comments and blank lines before the first requirement form an entry
    of their own, so they pass through untouched.
    """
    entries: list[list[str]] = []
    for line in lines:
        starts_entry = bool(line.strip()) and not line[:1].isspace() and not line.startswith("#")
        if starts_entry or not entries:
            entries.append([line])
        else:
            entries[-1].append(line)
    return entries


def is_requirement(entry: list[str]) -> bool:
    head = entry[0].strip()
    return bool(head) and not head.startswith(("#", "-"))


def apply_win_arm64(path: Path) -> None:
    entries = split_entries(path.read_text(encoding="utf-8").splitlines())
    out: list[str] = []
    dropped: set[str] = set()
    repinned: set[str] = set()
    for entry in entries:
        match = REQUIREMENT.match(entry[0])
        name = match.group(1).lower().replace("_", "-") if match else None
        if name in DROP:
            dropped.add(name)
            continue
        if name in REPIN:
            locked, pinned, digests = REPIN[name]
            if f"=={locked}" not in entry[0]:
                sys.exit(
                    f"ERROR: win-arm64 exception list expects {name}=={locked}, lock has: {entry[0]!r}\n"
                    f"       Re-check PyPI for a win_arm64 wheel before adjusting the pin."
                )
            # The old hashes describe the locked release, so they are replaced.
            hash_lines = [f"    --hash=sha256:{digest} \\" for digest in digests]
            hash_lines[-1] = hash_lines[-1][:-2]
            comments = [line for line in entry[1:] if line.lstrip().startswith("#")]
            out.append(f"{match.group(1)}=={pinned} \\")
            out.extend(hash_lines)
            out.extend(comments)
            repinned.add(name)
            continue
        out.extend(entry)

    stale = (set(DROP) - dropped) | (set(REPIN) - repinned)
    if stale:
        sys.exit(
            f"ERROR: win-arm64 exception list names packages the lock no longer contains: "
            f"{sorted(stale)}\n       The exception is obsolete — remove it from bundle-python.sh."
        )

    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("    dropped:  " + ", ".join(sorted(dropped)))
    print(
        "    re-pinned: " + ", ".join(f"{k}=={v[1]} (was {v[0]})" for k, v in sorted(REPIN.items()))
    )


def unhashed_requirements(lines: list[str]) -> list[str]:
    """The heads of requirement entries that carry no --hash line."""
    return [
        entry[0].strip()
        for entry in split_entries(lines)
        if is_requirement(entry) and not any("--hash=sha256:" in line for line in entry)
    ]


def check_hashes(path: Path) -> None:
    lines = path.read_text(encoding="utf-8").splitlines()
    requirements = [entry for entry in split_entries(lines) if is_requirement(entry)]
    if not requirements:
        sys.exit(f"ERROR: {path} lists no requirements; the export is empty or unreadable.")
    missing = unhashed_requirements(lines)
    if missing:
        sys.exit(
            "ERROR: these requirements carry no sha256 hash, so pip --require-hashes would refuse them:\n  "
            + "\n  ".join(missing)
            + "\n       Re-export with uv export --locked (hashes are on by default) and keep the hash lines."
        )
    print(f"    {len(requirements)} requirements, all hash-pinned")


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in ("win-arm64", "check-hashes"):
        print(__doc__, file=sys.stderr)
        return 2
    path = Path(argv[2])
    if argv[1] == "win-arm64":
        apply_win_arm64(path)
    else:
        check_hashes(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
