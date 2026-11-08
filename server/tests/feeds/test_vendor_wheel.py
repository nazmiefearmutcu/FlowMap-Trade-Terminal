"""The vendored crocodile engine is exactly one wheel, and the build pins that wheel.

``server/vendor`` holds the only copy of the crocodile engine the installer can
use (``[tool.uv.sources]`` in pyproject.toml, and the lock). A stale second wheel
or a version drift between the wheel, the lock and the pin is an install-time
surprise, so these checks run in the ordinary test suite.
"""

from pathlib import Path
import tomllib

import pytest

SERVER = Path(__file__).resolve().parents[2]
VENDOR = SERVER / "vendor"


def _vendored_crocodile_wheels() -> list[str]:
    return sorted(p.name for p in VENDOR.glob("crocodile-*.whl"))


def test_exactly_one_crocodile_wheel_is_vendored():
    wheels = _vendored_crocodile_wheels()
    assert len(wheels) == 1, f"expected exactly one crocodile wheel in server/vendor, found {wheels}"


def test_pyproject_pins_the_vendored_wheel():
    (wheel,) = _vendored_crocodile_wheels()
    pyproject = tomllib.loads((SERVER / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["tool"]["uv"]["sources"]["crocodile"]["path"] == f"vendor/{wheel}"


def test_lock_pins_the_vendored_wheel_at_the_same_version():
    (wheel,) = _vendored_crocodile_wheels()
    lock = tomllib.loads((SERVER / "uv.lock").read_text(encoding="utf-8"))
    (entry,) = [p for p in lock["package"] if p["name"] == "crocodile"]
    assert entry["source"] == {"path": f"vendor/{wheel}"}
    assert wheel == f"crocodile-{entry['version']}-py3-none-any.whl"


def test_vendor_gitignore_whitelists_the_vendored_wheel():
    (wheel,) = _vendored_crocodile_wheels()
    rules = (VENDOR / ".gitignore").read_text(encoding="utf-8").splitlines()
    assert f"!{wheel}" in rules


@pytest.mark.parametrize("stale", ["crocodile-0.3.0-py3-none-any.whl", "crocodile-0.3.1-py3-none-any.whl"])
def test_no_stale_crocodile_wheel_is_present(stale):
    assert not (VENDOR / stale).exists()
