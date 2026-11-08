"""The benchmark provenance hook loads only when its env var is set."""

from __future__ import annotations

import sys

import pytest

import flowmap_server.__main__ as entry

MODULE = "flowmap_server.benchmark_provenance"


def test_hook_is_a_no_op_and_never_imports_the_module_when_unset(monkeypatch):
    monkeypatch.delenv("FLOWMAP_BENCHMARK_PROVENANCE", raising=False)
    sys.modules.pop(MODULE, None)
    entry._benchmark_provenance()
    assert MODULE not in sys.modules


def test_write_provenance_refuses_a_report_without_the_owner_marker(monkeypatch, tmp_path):
    from flowmap_server import benchmark_provenance as bp

    profile = tmp_path / "profile"
    profile.mkdir()
    monkeypatch.setenv("FLOWMAP_BENCHMARK_PROVENANCE", str(profile / "sidecar-provenance.json"))
    monkeypatch.setenv("FLOWMAP_BENCHMARK_OWNER", "run-1")
    monkeypatch.setenv("FLOWMAP_BENCHMARK_PROFILE", str(profile))
    # No .flowmap-benchmark-owner file: the report must not be written.
    with pytest.raises((RuntimeError, OSError)):
        bp.write_provenance()
    assert not (profile / "sidecar-provenance.json").exists()


def test_write_provenance_refuses_a_non_canonical_report_name(monkeypatch, tmp_path):
    from flowmap_server import benchmark_provenance as bp

    profile = tmp_path / "profile"
    profile.mkdir()
    (profile / ".flowmap-benchmark-owner").write_text("run-1", encoding="utf-8")
    monkeypatch.setenv("FLOWMAP_BENCHMARK_PROVENANCE", str(profile / "other.json"))
    monkeypatch.setenv("FLOWMAP_BENCHMARK_OWNER", "run-1")
    monkeypatch.setenv("FLOWMAP_BENCHMARK_PROFILE", str(profile))
    with pytest.raises(RuntimeError):
        bp.write_provenance()
