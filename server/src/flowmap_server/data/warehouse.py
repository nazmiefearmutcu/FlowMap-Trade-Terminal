"""Local DuckDB analytical warehouse for FlowMap deep intelligence.

Persists and queries:
1. FINRA Dark Pool & Reg SHO TRF volumes
2. Gamma Exposure (GEX) historical snapshots & walls
3. Market Intelligence (DoD contracts, Congressional stock trades, FDA milestones)
4. SEC EDGAR Item 1A Risk Factors diff audits
5. Macro liquidity & credit risk spreads

It writes one database, ``warehouse.duckdb``, under ``FLOWMAP_DATA_DIR``
(default ``~/.flowmap/intelligence``), with DuckDB's own sidecar files beside it.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

import duckdb

log = logging.getLogger(__name__)

# Used when FLOWMAP_DATA_DIR is unset. Absolute (under the user profile), never
# CWD-relative: a relative default put the intelligence store in a different
# folder for each launch method and let a dev run leave an untracked database.
_DEFAULT_DATA_DIR = "~/.flowmap/intelligence"


class DuckWarehouse:
    """Local embedded DuckDB warehouse for FlowMap quantitative intelligence."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        if db_path is None:
            # Default to local app storage. expanduser(): a "~/..." value must
            # resolve to the profile, not create a literal "~" folder in the CWD.
            raw = os.environ.get("FLOWMAP_DATA_DIR") or _DEFAULT_DATA_DIR
            base_dir = Path(raw).expanduser().resolve()
            base_dir.mkdir(parents=True, exist_ok=True)
            self._db_path = str(base_dir / "warehouse.duckdb")
        else:
            self._db_path = str(db_path)

        self._con = duckdb.connect(self._db_path)
        self._init_schema()

    def _init_schema(self) -> None:
        """Initialize relational analytical schema."""
        self._con.execute(
            """
            CREATE TABLE IF NOT EXISTS darkpool_volume (
                date VARCHAR,
                symbol VARCHAR,
                short_volume DOUBLE,
                short_exempt_volume DOUBLE,
                total_volume DOUBLE,
                short_ratio DOUBLE,
                high_short_share BOOLEAN,
                updated_ts BIGINT,
                PRIMARY KEY (date, symbol)
            );

            CREATE TABLE IF NOT EXISTS gex_snapshots (
                ts_ns BIGINT,
                symbol VARCHAR,
                spot_price DOUBLE,
                gamma_flip DOUBLE,
                call_wall DOUBLE,
                put_wall DOUBLE,
                net_gex DOUBLE
            );

            CREATE TABLE IF NOT EXISTS market_intelligence (
                ts_ns BIGINT,
                kind VARCHAR,
                symbol VARCHAR,
                headline VARCHAR,
                amount_usd DOUBLE,
                detail VARCHAR,
                source VARCHAR,
                source_id VARCHAR
            );

            CREATE TABLE IF NOT EXISTS macro_stress (
                date VARCHAR,
                sofr DOUBLE,
                hy_spread DOUBLE,
                yield_10y2y DOUBLE,
                stress_score DOUBLE,
                status VARCHAR,
                updated_ts BIGINT
            );
            """
        )
        self._migrate_darkpool_column()
        self._migrate_darkpool_key()
        self._migrate_intelligence_source_id()

    def _columns(self, table: str) -> set[str]:
        return {
            row[0]
            for row in self._con.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
                [table],
            ).fetchall()
        }

    def _migrate_darkpool_column(self) -> None:
        """Rename the legacy divergence column to its honest name.

        The column is a short-share threshold flag (feeds/darkpool.py), not an
        institutional-divergence measure. Existing stores keep their rows.
        """
        columns = self._columns("darkpool_volume")
        if "is_institutional_divergence" in columns and "high_short_share" not in columns:
            self._con.execute(
                "ALTER TABLE darkpool_volume RENAME COLUMN "
                "is_institutional_divergence TO high_short_share"
            )

    def _migrate_darkpool_key(self) -> None:
        """Give a legacy darkpool table its (date, symbol) primary key.

        ``CREATE TABLE IF NOT EXISTS`` never alters an existing table, so a store
        created before the key existed would keep accepting duplicates and the
        upsert would not replace anything. The table is rebuilt in one
        transaction, keeping the newest row per (date, symbol).
        """
        keyed = (
            self._con.execute(
                "SELECT count(*) FROM duckdb_constraints() "
                "WHERE table_name = 'darkpool_volume' AND constraint_type = 'PRIMARY KEY'"
            ).fetchone()
            or (0,)
        )[0]
        if keyed:
            return
        self._con.execute("BEGIN TRANSACTION")
        try:
            self._con.execute(
                """
                CREATE TABLE darkpool_volume_keyed (
                    date VARCHAR,
                    symbol VARCHAR,
                    short_volume DOUBLE,
                    short_exempt_volume DOUBLE,
                    total_volume DOUBLE,
                    short_ratio DOUBLE,
                    high_short_share BOOLEAN,
                    updated_ts BIGINT,
                    PRIMARY KEY (date, symbol)
                )
                """
            )
            self._con.execute(
                """
                INSERT INTO darkpool_volume_keyed
                SELECT DISTINCT ON (date, symbol)
                    date, symbol, short_volume, short_exempt_volume, total_volume,
                    short_ratio, high_short_share, updated_ts
                FROM darkpool_volume
                ORDER BY date, symbol, updated_ts DESC NULLS LAST
                """
            )
            self._con.execute("DROP TABLE darkpool_volume")
            self._con.execute("ALTER TABLE darkpool_volume_keyed RENAME TO darkpool_volume")
            self._con.execute("COMMIT")
        except Exception:
            self._con.execute("ROLLBACK")
            raise

    def _migrate_intelligence_source_id(self) -> None:
        """Add the provider's stable row id and the (source, source_id) upsert key.

        Legacy rows have no source_id, and NULLs never conflict in a unique
        index, so they stay plain appends exactly as before.
        """
        if "source_id" not in self._columns("market_intelligence"):
            self._con.execute("ALTER TABLE market_intelligence ADD COLUMN source_id VARCHAR")
        self._con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS market_intelligence_source_key "
            "ON market_intelligence (source, source_id)"
        )

    def insert_darkpool_volume(
        self,
        date_str: str,
        symbol: str,
        short_vol: float,
        short_exempt_vol: float,
        total_vol: float,
        short_ratio: float,
        high_short_share: bool,
    ) -> None:
        """Upsert one (date, symbol) row: a refetch replaces it, never duplicates."""
        now_ts = time.time_ns()
        self._con.execute(
            """
            INSERT OR REPLACE INTO darkpool_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                date_str,
                symbol.upper(),
                short_vol,
                short_exempt_vol,
                total_vol,
                short_ratio,
                high_short_share,
                now_ts,
            ],
        )

    def replace_darkpool_day(self, date_str: str, rows: list[tuple]) -> int:
        """Replace every row of one trading date in a single transaction.

        ``rows`` are ``(symbol, short_vol, short_exempt_vol, total_vol,
        short_ratio, high_short_share)`` tuples. The delete and the bulk insert
        commit together, so a failed load leaves the previous day intact and a
        refetch never leaves a mix of old and new rows. Returns the
        number of rows written.
        """
        now_ts = time.time_ns()
        payload = [
            (date_str, symbol.upper(), short_vol, short_exempt_vol, total_vol,
             short_ratio, high_short_share, now_ts)
            for symbol, short_vol, short_exempt_vol, total_vol, short_ratio, high_short_share in rows
        ]
        self._con.execute("BEGIN TRANSACTION")
        try:
            self._con.execute("DELETE FROM darkpool_volume WHERE date = ?", [date_str])
            if payload:
                self._con.executemany(
                    "INSERT INTO darkpool_volume VALUES (?, ?, ?, ?, ?, ?, ?, ?)", payload
                )
            self._con.execute("COMMIT")
        except Exception:
            self._con.execute("ROLLBACK")
            raise
        return len(payload)

    def insert_gex_snapshot(
        self,
        ts_ns: int,
        symbol: str,
        spot_price: float,
        gamma_flip: float,
        call_wall: float,
        put_wall: float,
        net_gex: float,
    ) -> None:
        self._con.execute(
            """
            INSERT INTO gex_snapshots VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [ts_ns, symbol.upper(), spot_price, gamma_flip, call_wall, put_wall, net_gex],
        )

    def insert_intelligence(
        self,
        ts_ns: int,
        kind: str,
        symbol: str,
        headline: str,
        amount_usd: float | None,
        detail: str,
        source: str,
        source_id: str | None = None,
    ) -> None:
        """Store one event. With a ``source_id`` a repeat of ``(source, source_id)``
        updates the stored row instead of adding a duplicate. Without
        one the row is appended, as before, because NULL ids never conflict."""
        values = [ts_ns, kind, symbol.upper(), headline, amount_usd, detail, source, source_id]
        self._con.execute(
            """
            INSERT INTO market_intelligence
                (ts_ns, kind, symbol, headline, amount_usd, detail, source, source_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (source, source_id) DO UPDATE SET
                ts_ns = excluded.ts_ns,
                kind = excluded.kind,
                symbol = excluded.symbol,
                headline = excluded.headline,
                amount_usd = excluded.amount_usd,
                detail = excluded.detail
            """,
            values,
        )

    def insert_macro_stress(
        self,
        date_str: str,
        sofr: float,
        hy_spread: float,
        yield_10y2y: float,
        stress_score: float,
        status: str,
    ) -> None:
        now_ts = time.time_ns()
        self._con.execute(
            """
            INSERT INTO macro_stress VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [date_str, sofr, hy_spread, yield_10y2y, stress_score, status, now_ts],
        )

    def get_latest_gex(self, symbol: str) -> dict[str, Any] | None:
        res = self._con.execute(
            """
            SELECT ts_ns, symbol, spot_price, gamma_flip, call_wall, put_wall, net_gex
            FROM gex_snapshots
            WHERE symbol = ?
            ORDER BY ts_ns DESC
            LIMIT 1
            """,
            [symbol.upper()],
        ).fetchone()
        if not res:
            return None
        return {
            "ts_ns": res[0],
            "symbol": res[1],
            "spot_price": res[2],
            "gamma_flip": res[3],
            "call_wall": res[4],
            "put_wall": res[5],
            "net_gex": res[6],
        }

    def get_intelligence(self, symbol: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        if symbol:
            rows = self._con.execute(
                """
                SELECT ts_ns, kind, symbol, headline, amount_usd, detail, source
                FROM market_intelligence
                WHERE symbol = ?
                ORDER BY ts_ns DESC
                LIMIT ?
                """,
                [symbol.upper(), limit],
            ).fetchall()
        else:
            rows = self._con.execute(
                """
                SELECT ts_ns, kind, symbol, headline, amount_usd, detail, source
                FROM market_intelligence
                ORDER BY ts_ns DESC
                LIMIT ?
                """,
                [limit],
            ).fetchall()

        return [
            {
                "ts_ns": r[0],
                "kind": r[1],
                "symbol": r[2],
                "headline": r[3],
                "amount_usd": r[4],
                "detail": r[5],
                "source": r[6],
            }
            for r in rows
        ]

    def close(self) -> None:
        self._con.close()
