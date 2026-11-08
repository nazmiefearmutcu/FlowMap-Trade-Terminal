"""The intelligence collectors share one warehouse and close it at shutdown."""

import pytest

from flowmap_server.data.warehouse import DuckWarehouse
from flowmap_server.feeds import warehouse_share
from flowmap_server.feeds.capitol import CapitolTradesWatcher
from flowmap_server.feeds.contracts import DefenseContractsListener
from flowmap_server.feeds.darkpool import DarkPoolCollector
from flowmap_server.feeds.macro import MacroStressPoller


@pytest.fixture
def isolated_warehouse(monkeypatch, tmp_path):
    """Point the default warehouse at a temp folder and reset the shared handle."""
    monkeypatch.setenv("FLOWMAP_DATA_DIR", str(tmp_path))
    monkeypatch.setattr(warehouse_share, "_shared", None)
    yield
    warehouse_share.close_shared_warehouse()


def test_shared_warehouse_returns_one_handle(isolated_warehouse):
    assert warehouse_share.shared_warehouse() is warehouse_share.shared_warehouse()


def test_collectors_built_without_a_warehouse_share_the_same_handle(isolated_warehouse):
    handles = {
        DarkPoolCollector().warehouse,
        CapitolTradesWatcher().warehouse,
        DefenseContractsListener().warehouse,
        MacroStressPoller().warehouse,
    }
    assert handles == {warehouse_share.shared_warehouse()}


def test_an_explicit_warehouse_is_still_used_as_given(isolated_warehouse):
    explicit = object()
    assert DarkPoolCollector(warehouse=explicit).warehouse is explicit


def test_close_releases_the_handle_and_the_next_call_reopens(isolated_warehouse):
    first = warehouse_share.shared_warehouse()
    warehouse_share.close_shared_warehouse()
    assert warehouse_share._shared is None
    second = warehouse_share.shared_warehouse()
    assert second is not first
    assert isinstance(second, DuckWarehouse)


def test_close_is_a_no_op_when_nothing_is_open(isolated_warehouse):
    warehouse_share.close_shared_warehouse()
    warehouse_share.close_shared_warehouse()
    assert warehouse_share._shared is None
