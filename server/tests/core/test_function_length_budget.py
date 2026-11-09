"""No function in the server core, API or protocol packages passes the length ceiling.

The module budgets bound a file, not the functions inside it. A function that
keeps growing inside a budgeted file is the same unreviewable unit, so the
ceiling is checked per function. The stricter 100-line target is tracked
separately; this guard keeps the ceiling from being exceeded again.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[2] / "src" / "flowmap_server"
PACKAGES = ("core", "api", "proto")
MAX_FUNCTION_LINES = 150


def _sources() -> list[Path]:
    return sorted(path for name in PACKAGES for path in (SRC / name).rglob("*.py"))


def _too_long(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    offenders = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        length = node.end_lineno - node.lineno + 1
        if length > MAX_FUNCTION_LINES:
            offenders.append(f"{node.name} (line {node.lineno}): {length} lines")
    return offenders


@pytest.mark.parametrize("path", _sources(), ids=lambda p: p.relative_to(SRC).as_posix())
def test_functions_stay_under_the_length_ceiling(path: Path) -> None:
    assert not _too_long(path)
