"""Production comments state invariants, not the internal process that produced them.

Milestone, task, goal, gap and audit identifiers mean nothing to a reader of the
shipped feed, data and NLP code. The audit trail lives in CHANGELOG.md and the
issue tracker. This is the feed/data/nlp counterpart of the server-core guard.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SERVER_SRC = Path(__file__).resolve().parents[2] / "src" / "flowmap_server"
OWNED = ("feeds", "data", "nlp")

PROCESS_ID = re.compile(
    r"FM-\d{3}|\blane [A-Z]{2}\b|\bswarm\b|\bcampaign\b|\bround2\b|\bround \d\b|"
    r"\bM\d\b|\bT\d{1,2}\b|\bGOAL \d\b|\bgap\d-\d+\b|\bA2-\d|\bfeeds-\d+\b|"
    r"\bplan Task\b|\bTask \d+\b"
)


def _owned_files() -> list[Path]:
    files: list[Path] = []
    for name in OWNED:
        files.extend(sorted((SERVER_SRC / name).rglob("*.py")))
    return files


@pytest.mark.parametrize("path", _owned_files(), ids=lambda p: str(p.relative_to(SERVER_SRC)))
def test_no_process_identifiers_in_owned_source(path: Path) -> None:
    offenders = [
        f"{path.relative_to(SERVER_SRC)}:{number}: {line.strip()}"
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1)
        if PROCESS_ID.search(line)
    ]
    assert not offenders, "process identifiers in production comments:\n" + "\n".join(offenders)
