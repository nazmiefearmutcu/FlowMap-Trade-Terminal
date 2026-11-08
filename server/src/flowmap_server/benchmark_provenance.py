"""Benchmark sidecar provenance report.

Imported only when ``FLOWMAP_BENCHMARK_PROVENANCE`` is set, so a normal run never
loads this code. The benchmark harness starts the sidecar in an isolated
interpreter and asks it to record which executable and package it actually ran.
The report is written only into the benchmark's own profile directory and only
when the owner marker matches, so a stray environment variable cannot make a
production sidecar write files elsewhere.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import flowmap_server

__all__ = ["write_provenance"]


def write_provenance() -> None:
    """Write ``sidecar-provenance.json`` for a validated benchmark run.

    Raises ``RuntimeError`` when the report path, owner marker, profile
    directory or interpreter isolation do not match the benchmark contract."""
    report = os.environ.get("FLOWMAP_BENCHMARK_PROVENANCE")
    if not report:
        return
    path = Path(report).resolve()
    owner = os.environ.get("FLOWMAP_BENCHMARK_OWNER")
    profile = os.environ.get("FLOWMAP_BENCHMARK_PROFILE")
    same_profile = False
    if profile:
        try:
            same_profile = path.parent.is_dir() and Path(profile).is_dir() and path.parent.samefile(profile)
        except (OSError, ValueError):
            same_profile = False
    if (not owner or not same_profile
            or path.name != "sidecar-provenance.json"
            or (path.parent / ".flowmap-benchmark-owner").read_text(encoding="utf-8") != owner
            or not sys.flags.isolated or not sys.dont_write_bytecode):
        raise RuntimeError("Invalid benchmark provenance ownership/isolation")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"pid": os.getpid(), "owner": owner,
        "executable": str(Path(sys.executable).resolve()),
        "package_origin": str(Path(flowmap_server.__file__).resolve())}), encoding="utf-8")
    temporary.replace(path)
