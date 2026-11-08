"""Size budget for the Session modules, so the split cannot quietly grow back.

Session behaviour lives in ``core/session_*.py``. Each module has a line budget,
and each class has a length budget. Splitting a module again is the fix when a
budget trips, not raising the number.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

CORE = Path(__file__).resolve().parents[2] / "src" / "flowmap_server" / "core"
FACADE = "session.py"
MODULE_LINE_BUDGET = 800
FACADE_LINE_BUDGET = 1200
CLASS_LINE_BUDGET = 700


def _session_modules() -> list[Path]:
    return sorted(CORE.glob("session*.py"))


def _classes(path: Path) -> list[ast.ClassDef]:
    return [node for node in ast.parse(path.read_text(encoding="utf-8")).body
            if isinstance(node, ast.ClassDef)]


@pytest.mark.parametrize("path", _session_modules(), ids=lambda p: p.name)
def test_session_module_stays_within_its_line_budget(path: Path) -> None:
    lines = len(path.read_text(encoding="utf-8").splitlines())
    budget = FACADE_LINE_BUDGET if path.name == FACADE else MODULE_LINE_BUDGET
    assert lines <= budget, f"{path.name} has {lines} lines (budget {budget}); split it further"


@pytest.mark.parametrize("path", _session_modules(), ids=lambda p: p.name)
def test_session_class_stays_within_its_length_budget(path: Path) -> None:
    for cls in _classes(path):
        length = cls.end_lineno - cls.lineno + 1
        assert length <= CLASS_LINE_BUDGET, (
            f"{cls.name} in {path.name} spans {length} lines (budget {CLASS_LINE_BUDGET}); "
            "move a cohesive group of methods into a mixin module"
        )


def test_session_is_composed_from_mixins_not_one_body() -> None:
    session_cls = next(c for c in _classes(CORE / "session_core.py") if c.name == "Session")
    bases = [base.id for base in session_cls.bases if isinstance(base, ast.Name)]
    assert bases == ["BootMixin", "RecordingMixin", "FanoutMixin", "BookMixin", "HistoryMixin"]
