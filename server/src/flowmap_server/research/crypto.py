"""Crypto sections of the Research drawer, all from keyless public sources.

- ``derivatives``: Binance USDS-M perpetual futures for ``BASEUSDT`` (mark and
  index price, funding, open interest, account long/short and taker ratios). A
  pair counts only when Binance's ``exchangeInfo`` lists it as ``PERPETUAL`` and
  ``TRADING``; any other pair is ``not_applicable`` (reason ``no_perpetual``).
- ``options``: delegated to the options module (``crypto_gex``).
- ``market``: CoinGecko market data for the coin (top 250 by market cap), and its
  TVL from DefiLlama: the protocol whose ``gecko_id`` is the coin id, when that
  protocol has a numeric ``tvl`` (the largest, if several); otherwise the chain
  whose ``gecko_id`` is the coin id, with its ``tvl``; otherwise TVL is None.
  A matching protocol with a null TVL does not count, so the chain is used.
- ``sentiment``: the alternative.me Fear & Greed index, which is market-wide.

Shared source lists (CoinGecko markets, DefiLlama protocols and chains, the Binance
funding intervals and the perpetual set) are each read at most once per six hours
and single-flight: concurrent callers wait for one load. After a failed refresh a
list is not fetched again for 60 seconds; the previous list is served meanwhile,
and when there is none the failure is raised.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Iterable, Mapping
from datetime import UTC, date, datetime
import json
import logging
import math
import time
from typing import Any

from flowmap_server.research.base import Http, SectionResult, failure_reason, result
from flowmap_server.research.options import OptionsSource

__all__ = ["CryptoSource"]

logger = logging.getLogger(__name__)

MB = 1024 * 1024
SECOND_NS = 1_000_000_000
LIST_TTL_NS = 6 * 3600 * SECOND_NS
RETRY_FLOOR_NS = 60 * SECOND_NS
DEFAULT_FUNDING_HOURS = 8
MARKET_SYMBOL = "MARKET"

BINANCE = "https://fapi.binance.com"
DERIVATIVES_SOURCE = "Binance Futures"
EXCHANGE_INFO = f"{BINANCE}/fapi/v1/exchangeInfo"
COINGECKO_MARKETS = "https://api.coingecko.com/api/v3/coins/markets"
DEFILLAMA_PROTOCOLS = "https://api.llama.fi/protocols"
DEFILLAMA_CHAINS = "https://api.llama.fi/v2/chains"
MARKET_SOURCE = "CoinGecko and DefiLlama"
FEAR_GREED_URL = "https://api.alternative.me/fng/"
SENTIMENT_SOURCE = "alternative.me"


class _Held[T]:
    """One shared source list: kept six hours, single-flight, with a 60 s retry floor.

    Callers that find the list stale queue on one lock; the first loads, the rest
    re-check the value it stored. A failed load starts the floor: no new load
    until 60 s have passed. Meanwhile the previous value is served, or, with none
    held, the failure is raised again.
    """

    def __init__(self, clock: Callable[[], int]) -> None:
        self._clock = clock
        self._lock = asyncio.Lock()
        self._value: T | None = None
        self._at = 0
        self._failure: Exception | None = None
        self._failed_at = 0

    def _fresh(self) -> T | None:
        if self._value is not None and self._clock() - self._at < LIST_TTL_NS:
            return self._value
        return None

    async def get(self, load: Callable[[], Awaitable[T]]) -> T:
        fresh = self._fresh()
        if fresh is not None:
            return fresh
        async with self._lock:
            fresh = self._fresh()
            if fresh is not None:
                return fresh
            now = self._clock()
            if self._failure is None or now - self._failed_at >= RETRY_FLOOR_NS:
                try:
                    loaded = await load()
                except Exception as exc:
                    self._failure = exc
                    self._failed_at = now
                else:
                    self._value, self._at, self._failure = loaded, now, None
                    return loaded
            if self._value is not None:
                return self._value
            failure = self._failure
            if failure is None:
                raise RuntimeError("no list and no failure recorded")
            raise failure


class CryptoSource:
    """Every crypto section. Sources are read through ``Http``; options is delegated."""

    def __init__(
        self,
        http: Http,
        options: OptionsSource,
        *,
        clock: Callable[[], int] = time.time_ns,
    ) -> None:
        self._http = http
        self._options = options
        self._clock = clock
        self._perpetuals = _Held[frozenset[str]](clock)
        self._funding = _Held[dict[str, int]](clock)
        self._markets = _Held[list[dict[str, Any]]](clock)
        self._protocol_tvl = _Held[dict[str, float]](clock)
        self._chain_tvl = _Held[dict[str, float]](clock)

    async def derivatives(self, base: str) -> SectionResult:
        """Binance perpetual futures for ``BASEUSDT``; not_applicable when it is not a trading perpetual."""
        pair = f"{base}USDT"
        perpetuals = await self._perpetuals.get(self._load_perpetuals)
        if pair not in perpetuals:
            return self._answer("derivatives", base, "not_applicable", reason="no_perpetual")
        premium = _obj(
            await self._http.get_json(f"{BINANCE}/fapi/v1/premiumIndex", limit=MB, params={"symbol": pair})
        )
        # A TaskGroup cancels the siblings when one fails; its first error is re-raised unwrapped.
        try:
            async with asyncio.TaskGroup() as group:
                open_interest_task = group.create_task(
                    self._http.get_json(f"{BINANCE}/fapi/v1/openInterest", limit=MB, params={"symbol": pair})
                )
                long_short_task = group.create_task(
                    self._http.get_json(
                        f"{BINANCE}/futures/data/globalLongShortAccountRatio",
                        limit=MB,
                        params={"symbol": pair, "period": "1h", "limit": "1"},
                    )
                )
                taker_task = group.create_task(
                    self._http.get_json(
                        f"{BINANCE}/futures/data/takerlongshortRatio",
                        limit=MB,
                        params={"symbol": pair, "period": "1h", "limit": "1"},
                    )
                )
                interval_task = group.create_task(self._funding_interval(pair))
        except* Exception as errors:
            raise errors.exceptions[0] from None
        open_interest = _obj(open_interest_task.result())
        ratio = _latest(long_short_task.result())
        taker_row = _latest(taker_task.result())
        interval = interval_task.result()
        rate = _req_num(premium, "lastFundingRate")
        mark = _req_num(premium, "markPrice")
        coins = _req_num(open_interest, "openInterest")
        data: dict[str, Any] = {
            "pair": pair,
            "markPrice": mark,
            "indexPrice": _req_num(premium, "indexPrice"),
            "fundingRate": rate,
            "fundingIntervalHours": interval,
            "fundingRateAnnualPct": rate * 24 / interval * 365 * 100 if interval else None,
            "nextFundingTime": int(_req_num(premium, "nextFundingTime")),
            "openInterest": coins,
            "openInterestUsd": coins * mark,
            "longShortAccountRatio": None,
            "longAccountPct": None,
            "shortAccountPct": None,
            "takerBuySellRatio": None,
        }
        if ratio is not None:
            data["longShortAccountRatio"] = _req_num(ratio, "longShortRatio")
            data["longAccountPct"] = _req_num(ratio, "longAccount") * 100
            data["shortAccountPct"] = _req_num(ratio, "shortAccount") * 100
        if taker_row is not None:
            data["takerBuySellRatio"] = _req_num(taker_row, "buySellRatio")
        return self._answer(
            "derivatives",
            base,
            "ok",
            data=data,
            as_of=_day_of_ms(_req_num(premium, "time")),
        )

    async def options(self, base: str) -> SectionResult:
        """The options section; the options module owns the Deribit read."""
        return await self._options.crypto_gex(base)

    async def market(self, base: str) -> SectionResult:
        """CoinGecko market data for the coin with this symbol, plus its DefiLlama TVL."""
        rows = await self._markets.get(self._load_markets)
        row = _pick_row(rows, base)
        if row is None:
            return self._answer(
                "market", base, "not_applicable", reason="not_in_top_250", source=MARKET_SOURCE
            )
        coin_id = _text(row, "id")
        tvl, tvl_source, tvl_reason = await self._tvl(coin_id)
        data: dict[str, Any] = {
            "coinId": coin_id,
            "name": _text(row, "name"),
            "rank": _opt_int(row.get("market_cap_rank")),
            "price": _num(row.get("current_price")),
            "change24hPct": _num(row.get("price_change_percentage_24h_in_currency")),
            "change7dPct": _num(row.get("price_change_percentage_7d_in_currency")),
            "change30dPct": _num(row.get("price_change_percentage_30d_in_currency")),
            "marketCap": _num(row.get("market_cap")),
            "volume24h": _num(row.get("total_volume")),
            "circulatingSupply": _num(row.get("circulating_supply")),
            "totalSupply": _num(row.get("total_supply")),
            "maxSupply": _num(row.get("max_supply")),
            "ath": _num(row.get("ath")),
            "athChangePct": _num(row.get("ath_change_percentage")),
            "athDate": _day(row.get("ath_date")),
            "tvl": tvl,
            "tvlSource": tvl_source,
            "tvlReason": tvl_reason,
        }
        return self._answer(
            "market",
            base,
            "ok",
            data=data,
            as_of=_day(row.get("last_updated")),
            source=MARKET_SOURCE,
        )

    async def sentiment(self) -> SectionResult:
        """The Fear & Greed index for the last 30 days, newest first."""
        body = _obj(
            await self._http.get_json(FEAR_GREED_URL, limit=256 * 1024, params={"limit": "30"})
        )
        points: list[tuple[int, int, str]] = []
        for raw in _arr(body.get("data")):
            point = _obj(raw)
            points.append(
                (
                    int(_req_num(point, "timestamp")),
                    int(_req_num(point, "value")),
                    _text(point, "value_classification"),
                )
            )
        if not points:
            return self._answer("sentiment", MARKET_SYMBOL, "empty", source=SENTIMENT_SOURCE)
        points.sort(key=lambda point: point[0], reverse=True)
        newest = _date_of_s(points[0][0])
        dated = [(_date_of_s(ts), value) for ts, value, _ in points]
        data: dict[str, Any] = {
            "value": points[0][1],
            "label": points[0][2],
            "history": [{"date": day.isoformat(), "value": value} for day, value in dated],
            "avg7d": _mean(value for day, value in dated if (newest - day).days < 7),
            "avg30d": _mean(value for day, value in dated if (newest - day).days < 30),
        }
        return self._answer(
            "sentiment",
            MARKET_SYMBOL,
            "ok",
            data=data,
            as_of=newest.isoformat(),
            source=SENTIMENT_SOURCE,
        )

    async def close(self) -> None:
        return None

    def _answer(
        self,
        section: str,
        symbol: str,
        status: str,
        *,
        source: str = DERIVATIVES_SOURCE,
        data: Mapping[str, Any] | None = None,
        reason: str | None = None,
        as_of: str | None = None,
    ) -> SectionResult:
        return result(
            section,
            symbol,
            status,
            source=source,
            fetched_ns=self._clock(),
            data=data,
            reason=reason,
            as_of=as_of,
        )

    async def _read_json(
        self, url: str, *, limit: int, params: Mapping[str, str] | None = None
    ) -> object:
        """A large list: the body is read capped, then parsed off the event loop."""
        body = await self._http.get_bytes(url, limit=limit, params=params)
        return await asyncio.to_thread(json.loads, body)

    async def _funding_interval(self, pair: str) -> int | None:
        """Funding hours for a pair: its listed interval, else 8 (the default when not listed).

        None when the interval list cannot be read: the rest of the section still shows,
        and the annualized rate (which needs the interval) is left out.
        """
        try:
            intervals = await self._funding.get(self._load_funding)
        except Exception as exc:
            logger.warning("binance funding intervals unavailable: %s", failure_reason(exc))
            return None
        return intervals.get(pair, DEFAULT_FUNDING_HOURS)

    async def _load_perpetuals(self) -> frozenset[str]:
        body = _obj(await self._read_json(EXCHANGE_INFO, limit=8 * MB))
        trading: set[str] = set()
        for raw in _arr(body.get("symbols")):
            row = _obj(raw)
            symbol = row.get("symbol")
            if not isinstance(symbol, str):
                raise ValueError("exchangeInfo row without a symbol")
            if row.get("contractType") == "PERPETUAL" and row.get("status") == "TRADING":
                trading.add(symbol)
        return frozenset(trading)

    async def _load_funding(self) -> dict[str, int]:
        body = await self._read_json(f"{BINANCE}/fapi/v1/fundingInfo", limit=2 * MB)
        intervals: dict[str, int] = {}
        for raw in _arr(body):
            row = _obj(raw)
            symbol = row.get("symbol")
            hours = row.get("fundingIntervalHours")
            if not isinstance(symbol, str) or not isinstance(hours, int) or isinstance(hours, bool):
                raise ValueError("fundingInfo row without a symbol or interval")
            if hours <= 0:
                raise ValueError("fundingInfo interval is not positive")
            intervals[symbol] = hours
        return intervals

    async def _load_markets(self) -> list[dict[str, Any]]:
        body = await self._read_json(
            COINGECKO_MARKETS,
            limit=4 * MB,
            params={
                "vs_currency": "usd",
                "order": "market_cap_desc",
                "per_page": "250",
                "page": "1",
                "price_change_percentage": "24h,7d,30d",
            },
        )
        return [_obj(raw) for raw in _arr(body)]

    async def _tvl(self, coin_id: str) -> tuple[float | None, str | None, str | None]:
        """TVL in USD by the rule in the module docstring. A DefiLlama failure gives None and its reason."""
        try:
            protocols = await self._protocol_tvl.get(self._load_protocols)
        except Exception as exc:
            return None, None, failure_reason(exc)
        if coin_id in protocols:
            return protocols[coin_id], "protocol", None
        try:
            chains = await self._chain_tvl.get(self._load_chains)
        except Exception as exc:
            return None, None, failure_reason(exc)
        if coin_id in chains:
            return chains[coin_id], "chain", None
        return None, None, None

    async def _load_protocols(self) -> dict[str, float]:
        return _tvl_by_gecko(_arr(await self._read_json(DEFILLAMA_PROTOCOLS, limit=24 * MB)))

    async def _load_chains(self) -> dict[str, float]:
        return _tvl_by_gecko(_arr(await self._read_json(DEFILLAMA_CHAINS, limit=2 * MB)))


def _pick_row(rows: list[dict[str, Any]], base: str) -> dict[str, Any] | None:
    """The market row for a symbol; on a clash (two coins, one ticker) the largest market cap."""
    target = base.lower()
    matches = [row for row in rows if str(row.get("symbol", "")).lower() == target]
    if not matches:
        return None
    return max(matches, key=lambda row: _num(row.get("market_cap")) or 0.0)


def _tvl_by_gecko(rows: list[Any]) -> dict[str, float]:
    """The largest numeric TVL per CoinGecko id; rows without a numeric TVL are skipped."""
    totals: dict[str, float] = {}
    for raw in rows:
        row = _obj(raw)
        gecko = row.get("gecko_id")
        tvl = _num(row.get("tvl"))
        if not isinstance(gecko, str) or not gecko or tvl is None:
            continue
        totals[gecko] = max(tvl, totals.get(gecko, tvl))
    return totals


def _latest(body: object) -> dict[str, Any] | None:
    """The one row of a ``limit=1`` ratio reply, or None when the reply is empty."""
    rows = _arr(body)
    return _obj(rows[0]) if rows else None


def _obj(value: object) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def _arr(value: object) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError("expected a JSON array")
    return value


def _num(value: object) -> float | None:
    """A finite number from a JSON number or numeric string; None for null."""
    if value is None:
        return None
    if isinstance(value, (int, float, str)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            return number
    raise ValueError("expected a finite number")


def _req_num(row: Mapping[str, Any], key: str) -> float:
    value = _num(row.get(key))
    if value is None:
        raise ValueError(f"missing {key}")
    return value


def _text(row: Mapping[str, Any], key: str) -> str:
    value = row.get(key)
    if not isinstance(value, str):
        raise ValueError(f"missing {key}")
    return value


def _opt_int(value: object) -> int | None:
    number = _num(value)
    return None if number is None else int(number)


def _day(value: object) -> str | None:
    """The YYYY-MM-DD date at the start of an ISO timestamp, or None for null."""
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError("expected a date string")
    return date.fromisoformat(value[:10]).isoformat()


def _day_of_ms(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, UTC).date().isoformat()


def _date_of_s(seconds: int) -> date:
    return datetime.fromtimestamp(seconds, UTC).date()


def _mean(values: Iterable[int]) -> float | None:
    """Mean of the values, or None when fewer than two."""
    items = list(values)
    if len(items) < 2:
        return None
    return sum(items) / len(items)
