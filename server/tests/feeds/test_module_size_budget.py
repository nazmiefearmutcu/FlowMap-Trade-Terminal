"""Size budget for the feed, data and NLP modules, so a split stays a split.

Each module has a line budget and each class a length budget. When a budget
trips, split the module into a cohesive sibling module. Do not raise the number.
This is the feed, data and NLP counterpart of the Session budget in
tests/core/test_session_module_budget.py.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SERVER_SRC = Path(__file__).resolve().parents[2] / "src" / "flowmap_server"
PACKAGES = ("feeds", "data", "nlp")
MODULE_LINE_BUDGET = 800
CLASS_LINE_BUDGET = 700


def _modules() -> list[Path]:
    files: list[Path] = []
    for name in PACKAGES:
        files.extend(sorted((SERVER_SRC / name).rglob("*.py")))
    return files


def _classes(path: Path) -> list[ast.ClassDef]:
    return [
        node
        for node in ast.parse(path.read_text(encoding="utf-8")).body
        if isinstance(node, ast.ClassDef)
    ]


@pytest.mark.parametrize("path", _modules(), ids=lambda p: p.relative_to(SERVER_SRC).as_posix())
def test_module_stays_within_its_line_budget(path: Path) -> None:
    lines = len(path.read_text(encoding="utf-8").splitlines())
    assert lines <= MODULE_LINE_BUDGET, (
        f"{path.relative_to(SERVER_SRC).as_posix()} has {lines} lines "
        f"(budget {MODULE_LINE_BUDGET}); move a cohesive group into a sibling module"
    )


@pytest.mark.parametrize("path", _modules(), ids=lambda p: p.relative_to(SERVER_SRC).as_posix())
def test_class_stays_within_its_length_budget(path: Path) -> None:
    for cls in _classes(path):
        length = cls.end_lineno - cls.lineno + 1
        assert length <= CLASS_LINE_BUDGET, (
            f"{cls.name} in {path.name} spans {length} lines (budget {CLASS_LINE_BUDGET}); "
            "move a cohesive group of methods into a helper class or module"
        )
