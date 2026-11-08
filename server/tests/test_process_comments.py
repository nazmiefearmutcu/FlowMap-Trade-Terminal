"""Comments and docstrings state invariants, not the internal process that produced them.

Internal tracking identifiers mean nothing to a reader of the shipped code. The
audit trail lives in CHANGELOG.md and the issue tracker. The server source is
checked line by line. The test suites are checked through their comments and
string literals, so identifiers in test code (such as time zero) are not flagged.
"""

from __future__ import annotations

import io
import re
import tokenize
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
SERVER_SRC = TESTS.parent / "src" / "flowmap_server"
# The server-side areas covered by this guard.
OWNED_SRC = ("core", "api", "proto", "logging_setup.py", "__main__.py", "config.py", "benchmark_provenance.py")
OWNED_TESTS = ("core", "api", "proto")

PROCESS_ID = re.compile(
    r"FM-\d{3}|\blanes?\b|\blane [A-Z]{2}\b|\bswarm\b|\bcampaign\b|NEEDS-CORE|\bcontract C\d|"
    r"\bsurvey-?\d|\bgap\d-\d|\bcore-\d{2}\b|\bapi-\d{2}\b|\bM\d( T\d+)?\b|"
    r"\bT\d{1,2}\b|\bGOAL \d\b|\bC\d\b|\bH\d\b|\bR\d-[A-Z]\d\b|\bQA\d+\b|"
    r"\bround \d\b|\baudit FM|\bSB item|\bSA\b|\bSB\b|"
    r"\bA\d-\d+\b|\b[Rr]ound-?\d\b|\bR\d\b|\bM-\d\b|"
    r"\bwave[ -]?\d+\b|\bwave N\b|\bF\d+/T\d+\b|\bgap-?\d+\b"
)


def _source_files() -> list[Path]:
    files: list[Path] = []
    for name in OWNED_SRC:
        target = SERVER_SRC / name
        if target.is_dir():
            files.extend(sorted(target.rglob("*.py")))
        elif target.is_file():
            files.append(target)
    return files


def _test_files() -> list[Path]:
    files: list[Path] = []
    for name in OWNED_TESTS:
        files.extend(sorted((TESTS / name).rglob("*.py")))
    files.extend(p for p in sorted(TESTS.glob("test_*.py")) if p.name != Path(__file__).name)
    return files


def _label(path: Path) -> str:
    root = SERVER_SRC if path.is_relative_to(SERVER_SRC) else TESTS.parent
    return path.relative_to(root).as_posix()


@pytest.mark.parametrize("path", _source_files(), ids=_label)
def test_no_process_identifiers_in_owned_source(path: Path) -> None:
    offenders = [
        f"{number}: {line.strip()}"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if PROCESS_ID.search(line)
    ]
    assert not offenders, "process identifiers in production comments:\n" + "\n".join(offenders)


@pytest.mark.parametrize("path", _test_files(), ids=_label)
def test_no_process_identifiers_in_owned_test_comments(path: Path) -> None:
    offenders = []
    text = path.read_text(encoding="utf-8")
    for tok in tokenize.generate_tokens(io.StringIO(text).readline):
        if tok.type not in (tokenize.COMMENT, tokenize.STRING):
            continue
        for offset, line in enumerate(tok.string.splitlines()):
            if PROCESS_ID.search(line):
                offenders.append(f"{tok.start[0] + offset}: {line.strip()}")
    assert not offenders, "process identifiers in test comments:\n" + "\n".join(offenders)
