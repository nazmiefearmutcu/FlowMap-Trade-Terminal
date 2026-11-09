"""Size budget for the feed, data, NLP and non-session core modules, so a split stays a split.

Each module has a line budget and each class a length budget. When a budget
trips, split the module into a cohesive sibling module. Do not raise the number.
The Session modules (``core/session*.py``) have their own budget in
tests/core/test_session_module_budget.py.

The core modules that are over budget today are listed as ratchet ceilings with
their current size. A ceiling may only go down: growth fails the first test, and
a shrink fails the second until the ceiling is lowered to the new size, so the
list empties as the split lands.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SERVER_SRC = Path(__file__).resolve().parents[2] / "src" / "flowmap_server"
PACKAGES = ("feeds", "data", "nlp")
MODULE_LINE_BUDGET = 800
CLASS_LINE_BUDGET = 700

# Ratchet ceilings for core modules still over budget, keyed by path under src/flowmap_server.
LEGACY_MODULE_CEILINGS: dict[str, int] = {
    "core/backfill.py": 835,
    "core/grid.py": 1191,
    "core/overview.py": 1296,
    "core/pyramid.py": 1216,
    "core/record.py": 1605,
}
# Ratchet ceilings for classes still over budget, keyed by "path::ClassName".
LEGACY_CLASS_CEILINGS: dict[str, int] = {
    "core/grid.py::Grid": 990,
    "core/pyramid.py::PersistentPyramid": 951,
}


def _relative(path: Path) -> str:
    return path.relative_to(SERVER_SRC).as_posix()


def _modules() -> list[Path]:
    files: list[Path] = []
    for name in PACKAGES:
        files.extend(sorted((SERVER_SRC / name).rglob("*.py")))
    files.extend(
        path for path in sorted((SERVER_SRC / "core").glob("*.py"))
        if not path.name.startswith("session")
    )
    return files


def _classes(path: Path) -> list[ast.ClassDef]:
    return [
        node
        for node in ast.parse(path.read_text(encoding="utf-8")).body
        if isinstance(node, ast.ClassDef)
    ]


def _line_count(path: Path) -> int:
    return len(path.read_text(encoding="utf-8").splitlines())


@pytest.mark.parametrize("path", _modules(), ids=_relative)
def test_module_stays_within_its_line_budget(path: Path) -> None:
    lines = _line_count(path)
    budget = LEGACY_MODULE_CEILINGS.get(_relative(path), MODULE_LINE_BUDGET)
    assert lines <= budget, (
        f"{_relative(path)} has {lines} lines "
        f"(budget {budget}); move a cohesive group into a sibling module"
    )


@pytest.mark.parametrize("path", _modules(), ids=_relative)
def test_class_stays_within_its_length_budget(path: Path) -> None:
    for cls in _classes(path):
        length = cls.end_lineno - cls.lineno + 1
        key = f"{_relative(path)}::{cls.name}"
        budget = LEGACY_CLASS_CEILINGS.get(key, CLASS_LINE_BUDGET)
        assert length <= budget, (
            f"{cls.name} in {path.name} spans {length} lines (budget {budget}); "
            "move a cohesive group of methods into a helper class or module"
        )


@pytest.mark.parametrize("relative", sorted(LEGACY_MODULE_CEILINGS), ids=str)
def test_legacy_module_ceiling_matches_the_module(relative: str) -> None:
    path = SERVER_SRC / relative
    assert path.is_file(), f"{relative} is listed as a legacy ceiling but does not exist"
    lines = _line_count(path)
    assert lines == LEGACY_MODULE_CEILINGS[relative], (
        f"{relative} has {lines} lines; set its ceiling to {lines}, or remove it "
        f"from LEGACY_MODULE_CEILINGS once it is within {MODULE_LINE_BUDGET}"
    )


@pytest.mark.parametrize("key", sorted(LEGACY_CLASS_CEILINGS), ids=str)
def test_legacy_class_ceiling_matches_the_class(key: str) -> None:
    relative, class_name = key.split("::")
    path = SERVER_SRC / relative
    matches = [cls for cls in _classes(path) if cls.name == class_name]
    assert matches, f"{key} is listed as a legacy ceiling but does not exist"
    length = matches[0].end_lineno - matches[0].lineno + 1
    assert length == LEGACY_CLASS_CEILINGS[key], (
        f"{key} spans {length} lines; set its ceiling to {length}, or remove it "
        f"from LEGACY_CLASS_CEILINGS once it is within {CLASS_LINE_BUDGET}"
    )
