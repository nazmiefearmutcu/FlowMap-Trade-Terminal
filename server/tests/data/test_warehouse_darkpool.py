"""Warehouse darkpool fixes: honest column name, upsert, per-day atomic replace."""

import duckdb

from flowmap_server.data.warehouse import DuckWarehouse


def _columns(wh: DuckWarehouse) -> set[str]:
    return {
        row[0]
        for row in wh._con.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'darkpool_volume'"
        ).fetchall()
    }


def test_new_store_uses_the_honest_column_name_and_a_primary_key(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    assert "high_short_share" in _columns(wh)
    assert "is_institutional_divergence" not in _columns(wh)
    wh.close()


def test_refetching_a_row_replaces_it(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    wh.insert_darkpool_volume("2026-01-02", "aapl", 10.0, 1.0, 20.0, 0.5, True)
    wh.insert_darkpool_volume("2026-01-02", "AAPL", 11.0, 1.0, 22.0, 0.5, False)
    rows = wh._con.execute("SELECT symbol, short_volume, high_short_share FROM darkpool_volume").fetchall()
    assert rows == [("AAPL", 11.0, False)]
    wh.close()


def test_replace_day_swaps_only_that_date(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    wh.insert_darkpool_volume("2026-01-01", "AAA", 1.0, 0.0, 2.0, 0.5, False)
    wh.insert_darkpool_volume("2026-01-02", "OLD", 9.0, 0.0, 9.0, 1.0, True)
    written = wh.replace_darkpool_day(
        "2026-01-02",
        [("new", 3.0, 0.0, 6.0, 0.5, False), ("zz", 4.0, 0.0, 8.0, 0.5, True)],
    )
    assert written == 2
    rows = wh._con.execute(
        "SELECT date, symbol FROM darkpool_volume ORDER BY date, symbol"
    ).fetchall()
    assert rows == [("2026-01-01", "AAA"), ("2026-01-02", "NEW"), ("2026-01-02", "ZZ")]
    wh.close()


def test_failed_day_replace_rolls_back_and_keeps_the_previous_day(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    wh.insert_darkpool_volume("2026-01-02", "OLD", 9.0, 0.0, 9.0, 1.0, True)
    try:
        wh.replace_darkpool_day("2026-01-02", [("bad", "not-a-number", 0.0, 1.0, 0.5, False)])
    except duckdb.Error:
        pass
    else:
        raise AssertionError("a bad row must fail the load")
    rows = wh._con.execute("SELECT symbol FROM darkpool_volume").fetchall()
    assert rows == [("OLD",)]
    # The connection is still usable: no transaction was left open.
    wh.insert_darkpool_volume("2026-01-03", "NEXT", 1.0, 0.0, 1.0, 1.0, False)
    assert wh._con.execute("SELECT count(*) FROM darkpool_volume").fetchone()[0] == 2
    wh.close()


def test_existing_store_with_the_old_column_is_migrated_in_place(tmp_path):
    path = tmp_path / "old.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        """
        CREATE TABLE darkpool_volume (
            date VARCHAR, symbol VARCHAR, short_volume DOUBLE, short_exempt_volume DOUBLE,
            total_volume DOUBLE, short_ratio DOUBLE, is_institutional_divergence BOOLEAN,
            updated_ts BIGINT
        )
        """
    )
    con.execute("INSERT INTO darkpool_volume VALUES ('2025-12-31', 'SPY', 1, 0, 2, 0.5, true, 1)")
    con.close()
    wh = DuckWarehouse(path)
    assert "high_short_share" in _columns(wh)
    assert "is_institutional_divergence" not in _columns(wh)
    assert wh._con.execute("SELECT high_short_share FROM darkpool_volume").fetchall() == [(True,)]
    wh.close()


def _has_primary_key(wh: DuckWarehouse, table: str) -> bool:
    return bool(
        wh._con.execute(
            "SELECT count(*) FROM duckdb_constraints() "
            "WHERE table_name = ? AND constraint_type = 'PRIMARY KEY'",
            [table],
        ).fetchone()[0]
    )


def test_legacy_darkpool_table_gets_a_key_and_keeps_the_newest_duplicate(tmp_path):
    path = tmp_path / "keyless.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        """
        CREATE TABLE darkpool_volume (
            date VARCHAR, symbol VARCHAR, short_volume DOUBLE, short_exempt_volume DOUBLE,
            total_volume DOUBLE, short_ratio DOUBLE, high_short_share BOOLEAN,
            updated_ts BIGINT
        )
        """
    )
    # Two refetches of the same day from the keyless build, plus one other day.
    con.execute(
        "INSERT INTO darkpool_volume VALUES "
        "('2026-01-02', 'AAPL', 1, 0, 2, 0.5, false, 10), "
        "('2026-01-02', 'AAPL', 5, 0, 9, 0.5, true, 20), "
        "('2026-01-03', 'MSFT', 3, 0, 4, 0.5, false, 30)"
    )
    con.close()

    wh = DuckWarehouse(path)
    assert _has_primary_key(wh, "darkpool_volume")
    rows = wh._con.execute(
        "SELECT date, symbol, short_volume, high_short_share FROM darkpool_volume ORDER BY date"
    ).fetchall()
    assert rows == [("2026-01-02", "AAPL", 5.0, True), ("2026-01-03", "MSFT", 3.0, False)]
    # The upsert now replaces instead of appending.
    wh.insert_darkpool_volume("2026-01-03", "MSFT", 7.0, 0.0, 8.0, 0.9, True)
    assert wh._con.execute("SELECT count(*) FROM darkpool_volume").fetchone()[0] == 2
    wh.close()

    # Reopening an already keyed store is a no-op, not a second rebuild.
    again = DuckWarehouse(path)
    assert _has_primary_key(again, "darkpool_volume")
    again.close()


def test_intelligence_with_a_source_id_is_upserted(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    wh.insert_intelligence(1, "capitol", "aapl", "first", None, "d", "House Stock Watcher", "tx-9")
    wh.insert_intelligence(2, "capitol", "AAPL", "second", 5.0, "d2", "House Stock Watcher", "tx-9")
    rows = wh._con.execute(
        "SELECT ts_ns, symbol, headline, amount_usd, source_id FROM market_intelligence"
    ).fetchall()
    assert rows == [(2, "AAPL", "second", 5.0, "tx-9")]
    wh.close()


def test_intelligence_without_a_source_id_is_appended_as_before(tmp_path):
    wh = DuckWarehouse(tmp_path / "wh.duckdb")
    wh.insert_intelligence(1, "defense_contract", "PLTR", "A", 1.0, "x", "USASpending")
    wh.insert_intelligence(1, "defense_contract", "PLTR", "A", 1.0, "x", "USASpending")
    assert wh._con.execute("SELECT count(*) FROM market_intelligence").fetchone()[0] == 2
    assert len(wh.get_intelligence("PLTR")) == 2
    wh.close()


def test_legacy_intelligence_table_is_migrated_and_keeps_its_rows(tmp_path):
    path = tmp_path / "old_intel.duckdb"
    con = duckdb.connect(str(path))
    con.execute(
        """
        CREATE TABLE market_intelligence (
            ts_ns BIGINT, kind VARCHAR, symbol VARCHAR, headline VARCHAR,
            amount_usd DOUBLE, detail VARCHAR, source VARCHAR
        )
        """
    )
    con.execute("INSERT INTO market_intelligence VALUES (5, 'capitol', 'SPY', 'h', NULL, 'd', 'src')")
    con.close()

    wh = DuckWarehouse(path)
    assert "source_id" in {
        row[0]
        for row in wh._con.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'market_intelligence'"
        ).fetchall()
    }
    wh.insert_intelligence(6, "capitol", "SPY", "h2", None, "d", "src", "id-1")
    wh.insert_intelligence(7, "capitol", "SPY", "h2", None, "d", "src", "id-1")
    rows = wh._con.execute(
        "SELECT ts_ns, source_id FROM market_intelligence ORDER BY ts_ns"
    ).fetchall()
    assert rows == [(5, None), (7, "id-1")]
    wh.close()
