"""The resident pyramid LRU is bounded by estimated manifest bytes, not count alone."""

import hashlib
import threading
from pathlib import Path
from types import SimpleNamespace

from flowmap_server.core import pyramid
from flowmap_server.core.pyramid import pyramid_for


def _root(base: Path):
    root = SimpleNamespace(_column_time_lock=threading.Lock())
    root._symbol_dir = lambda market, symbol: base / market / symbol
    return root


def _manifest(base: Path, symbol: str, recording_id: str, size: int) -> None:
    namespace = hashlib.sha256(recording_id.encode()).hexdigest()[:32]
    directory = base / "sim" / symbol / ".flowmap-pyramid" / namespace
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.json").write_bytes(b"{" + b" " * (size - 2) + b"}")


def test_byte_budget_evicts_least_recently_used_stores(tmp_path, monkeypatch):
    monkeypatch.setattr(pyramid, "RESIDENT_MANIFEST_BYTES", 1000)
    root = _root(tmp_path)
    for symbol in ("A", "B", "C"):
        _manifest(tmp_path, symbol, f"rec-{symbol}", 600)  # 1200 estimated bytes each
    pyramid_for(root, "sim", "A", "rec-A")
    pyramid_for(root, "sim", "B", "rec-B")
    assert list(root._persistent_pyramids) == [("sim", "B", "rec-B")]
    pyramid_for(root, "sim", "C", "rec-C")
    assert list(root._persistent_pyramids) == [("sim", "C", "rec-C")]


def test_a_single_oversized_store_is_still_kept(tmp_path, monkeypatch):
    monkeypatch.setattr(pyramid, "RESIDENT_MANIFEST_BYTES", 100)
    root = _root(tmp_path)
    _manifest(tmp_path, "BIG", "rec-big", 600)
    store = pyramid_for(root, "sim", "BIG", "rec-big")
    assert store is not None
    assert list(root._persistent_pyramids) == [("sim", "BIG", "rec-big")]


def test_count_limit_still_applies(tmp_path, monkeypatch):
    monkeypatch.setattr(pyramid, "MAX_RESIDENT_PYRAMIDS", 2)
    root = _root(tmp_path)
    for symbol in ("A", "B", "C"):
        pyramid_for(root, "sim", symbol, f"rec-{symbol}")
    assert [key[1] for key in root._persistent_pyramids] == ["B", "C"]
