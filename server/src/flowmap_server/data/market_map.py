"""Market map data: parse two public screeners and serve them from a short cache.

US stocks come from the Nasdaq public screener and crypto from CoinGecko. Both
are keyless. The parsers turn a raw payload into map tiles (symbol, name, group,
market cap, price, change, volume and an optional chart symbol). The service
keeps each answer for a minute, and when a refresh fails it serves the last good
answer marked stale instead of an error.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import ssl
import time
from collections.abc import Awaitable, Callable, Collection

import aiohttp
import certifi
import msgspec

from flowmap_server.data.universe import CRYPTO_MARKET, CRYPTO_SYMBOLS

__all__ = [
    "CACHE_TTL_S",
    "CRYPTO_LIMIT",
    "CRYPTO_SOURCE",
    "EXCLUDED_COINS",
    "US_LIMIT",
    "US_SOURCE",
    "MapItem",
    "MarketMap",
    "MarketMapService",
    "MarketMapUnavailable",
    "parse_crypto",
    "parse_us",
]

logger = logging.getLogger(__name__)

US_LIMIT = 500
CRYPTO_LIMIT = 100
CACHE_TTL_S = 60.0
# After a failed refresh the source is left alone for this long.
RETRY_AFTER_FAILURE_S = 15.0

US_SOURCE = "Nasdaq screener"
CRYPTO_SOURCE = "CoinGecko"
_SOURCE_NAMES = {"us": US_SOURCE, "crypto": CRYPTO_SOURCE}

_US_URL = (
    "https://api.nasdaq.com/api/screener/stocks"
    "?tableonly=true&limit=25&offset=0&download=true"
)
_US_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
}
_US_TIMEOUT_S = 12.0
_CRYPTO_URL = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1"
    "&price_change_percentage=1h,24h,7d"
)
_CRYPTO_HEADERS = {"Accept": "application/json"}
_CRYPTO_TIMEOUT_S = 8.0

# Share-class and listing descriptions that make a tile label noisy. The name is
# cut at the earliest one that appears.
_US_NAME_CUTS = (
    " Common Stock",
    " Class A",
    " Class B",
    " Class C",
    " American Depositary",
    " Ordinary Shares",
    " Depositary Shares",
)
_CHART_SYMBOL = re.compile(r"[A-Z0-9.\-]+")

# Stablecoins and wrapped or staked duplicates of a coin that is already listed.
EXCLUDED_COINS: frozenset[str] = frozenset({
    "USDT", "USDC", "DAI", "USDS", "USDE", "FDUSD", "PYUSD", "TUSD", "USD1", "USDD",
    "BUSD", "USDT0", "RLUSD", "USDF", "USDG", "BSC-USD", "WBTC", "WETH", "WEETH",
    "STETH", "WSTETH", "CBBTC", "CBETH", "RETH", "WBETH", "LBTC", "JITOSOL", "BNSOL",
    "MSOL", "SUSDE", "SUSDS", "BUIDL", "USDTB",
})
_CRYPTO_PERIODS = (
    ("1h", "price_change_percentage_1h_in_currency"),
    ("24h", "price_change_percentage_24h_in_currency"),
    ("7d", "price_change_percentage_7d_in_currency"),
)


class MapItem(msgspec.Struct, frozen=True):
    symbol: str
    name: str
    group: str  # sector for stocks; "Crypto" for coins
    market_cap: float
    price: float
    change: dict[str, float]  # period -> percent, e.g. {"1d": -2.21}
    volume: float | None
    chart: dict[str, str] | None  # {"market": "equity", "symbol": "NVDA"} or None


class MarketMap(msgspec.Struct, frozen=True):
    market: str  # "us" | "crypto"
    as_of_ns: int  # when this answer was fetched, UTC ns
    source: str  # "Nasdaq screener" | "CoinGecko"
    stale: bool
    items: tuple[MapItem, ...]


class MarketMapUnavailable(Exception):
    """No answer can be served: the source failed and nothing is cached."""


def _number(value: object) -> float | None:
    """A finite float from a number or a string such as ``"$1,234.50"``, else None."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        text = value.strip().replace("$", "").replace(",", "").replace("%", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    elif isinstance(value, (int, float)):
        number = float(value)
    else:
        return None
    return number if math.isfinite(number) else None


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _clean_name(name: str, symbol: str) -> str:
    cut = len(name)
    for marker in _US_NAME_CUTS:
        at = name.find(marker)
        if at != -1:
            cut = min(cut, at)
    return name[:cut].strip() or symbol


def _us_item(row: object) -> MapItem | None:
    if not isinstance(row, dict):
        return None
    symbol = _text(row.get("symbol"))
    market_cap = _number(row.get("marketCap"))
    price = _number(row.get("lastsale"))
    if not symbol or market_cap is None or market_cap <= 0 or price is None or price <= 0:
        return None
    change: dict[str, float] = {}
    pct = _number(row.get("pctchange"))
    if pct is not None:
        change["1d"] = pct
    # The Nasdaq list writes share classes as "BRK/B"; the chart feed wants "BRK.B".
    chart_symbol = symbol.replace("/", ".")
    chart = (
        {"market": "equity", "symbol": chart_symbol}
        if _CHART_SYMBOL.fullmatch(chart_symbol)
        else None
    )
    return MapItem(
        symbol=symbol,
        name=_clean_name(_text(row.get("name")), symbol),
        group=_text(row.get("sector")) or "Other",
        market_cap=market_cap,
        price=price,
        change=change,
        volume=_number(row.get("volume")),
        chart=chart,
    )


def parse_us(payload: object, *, limit: int = US_LIMIT) -> tuple[MapItem, ...]:
    """Tiles for the largest US stocks, largest market cap first.

    Raises ``ValueError`` when the payload has no ``data.rows`` list or no row
    survives the checks.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), dict):
        raise ValueError("Nasdaq screener payload has no data object")
    rows = payload["data"].get("rows")
    if not isinstance(rows, list):
        raise ValueError("Nasdaq screener payload has no rows list")
    items = [item for row in rows if (item := _us_item(row)) is not None]
    if not items:
        raise ValueError("Nasdaq screener payload has no usable rows")
    items.sort(key=lambda i: (-i.market_cap, i.symbol))
    return tuple(items[:limit])


def _coin_item(row: object, known_pairs: Collection[str]) -> MapItem | None:
    if not isinstance(row, dict):
        return None
    symbol = _text(row.get("symbol")).upper()
    if not symbol or symbol in EXCLUDED_COINS:
        return None
    market_cap = _number(row.get("market_cap"))
    price = _number(row.get("current_price"))
    if market_cap is None or market_cap <= 0 or price is None or price <= 0:
        return None
    change: dict[str, float] = {}
    for period, field in _CRYPTO_PERIODS:
        value = _number(row.get(field))
        if value is not None:
            change[period] = value
    pair = f"{symbol}USDT"
    return MapItem(
        symbol=symbol,
        name=_text(row.get("name")) or symbol,
        group="Crypto",
        market_cap=market_cap,
        price=price,
        change=change,
        volume=_number(row.get("total_volume")),
        chart={"market": CRYPTO_MARKET, "symbol": pair} if pair in known_pairs else None,
    )


def parse_crypto(
    payload: object,
    *,
    limit: int = CRYPTO_LIMIT,
    known_pairs: Collection[str] = CRYPTO_SYMBOLS,
) -> tuple[MapItem, ...]:
    """Tiles for the largest coins, largest market cap first.

    Stablecoins and wrapped duplicates are left out. Raises ``ValueError`` when
    the payload is not a list or no row survives the checks.
    """
    if not isinstance(payload, list):
        raise ValueError("CoinGecko payload is not a list")
    items = [item for row in payload if (item := _coin_item(row, known_pairs)) is not None]
    if not items:
        raise ValueError("CoinGecko payload has no usable rows")
    items.sort(key=lambda i: (-i.market_cap, i.symbol))
    return tuple(items[:limit])


class MarketMapService:
    """Answers for both markets, cached for ``ttl_s`` seconds.

    Concurrent callers for one market share a single fetch. A failed refresh
    returns the previous answer with ``stale=True`` when there is one, and is not
    retried for ``RETRY_AFTER_FAILURE_S`` seconds.
    """

    def __init__(
        self,
        *,
        fetch_us: Callable[[], Awaitable[object]] | None = None,
        fetch_crypto: Callable[[], Awaitable[object]] | None = None,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        ttl_s: float = CACHE_TTL_S,
    ) -> None:
        self._fetchers: dict[str, Callable[[], Awaitable[object]]] = {
            "us": fetch_us or self._fetch_us,
            "crypto": fetch_crypto or self._fetch_crypto,
        }
        self._clock = clock
        self._monotonic = monotonic
        self._ttl_s = ttl_s
        # market -> (answer, monotonic time it was fetched)
        self._answers: dict[str, tuple[MarketMap, float]] = {}
        self._failed_at: dict[str, float] = {}
        self._locks = {market: asyncio.Lock() for market in _SOURCE_NAMES}
        self._session: aiohttp.ClientSession | None = None

    async def get(self, market: str) -> MarketMap:
        if market not in _SOURCE_NAMES:
            raise ValueError(f"unknown market {market!r}")
        fresh = self._fresh(market)
        if fresh is not None:
            return fresh
        async with self._locks[market]:
            fresh = self._fresh(market)
            if fresh is not None:
                return fresh
            failed_at = self._failed_at.get(market)
            if failed_at is None or self._monotonic() - failed_at >= RETRY_AFTER_FAILURE_S:
                try:
                    items = await self._load(market)
                except Exception as exc:
                    self._failed_at[market] = self._monotonic()
                    logger.warning(
                        "market map refresh for %s failed: %s: %s",
                        market, type(exc).__name__, exc,
                    )
                else:
                    answer = MarketMap(
                        market=market,
                        as_of_ns=self._clock(),
                        source=_SOURCE_NAMES[market],
                        stale=False,
                        items=items,
                    )
                    self._answers[market] = (answer, self._monotonic())
                    self._failed_at.pop(market, None)
                    return answer
            return self._fallback(market)

    async def close(self) -> None:
        session, self._session = self._session, None
        if session is not None and not session.closed:
            await session.close()

    def _fresh(self, market: str) -> MarketMap | None:
        held = self._answers.get(market)
        if held is None:
            return None
        answer, fetched_at = held
        return answer if self._monotonic() - fetched_at < self._ttl_s else None

    def _fallback(self, market: str) -> MarketMap:
        held = self._answers.get(market)
        if held is None:
            raise MarketMapUnavailable(f"{_SOURCE_NAMES[market]} is unavailable right now")
        previous = held[0]
        return MarketMap(
            market=previous.market,
            as_of_ns=previous.as_of_ns,
            source=previous.source,
            stale=True,
            items=previous.items,
        )

    async def _load(self, market: str) -> tuple[MapItem, ...]:
        payload = await self._fetchers[market]()
        if market == "us":
            return parse_us(payload)
        return parse_crypto(payload)

    async def _fetch_us(self) -> object:
        return await self._get_json(_US_URL, headers=_US_HEADERS, timeout_s=_US_TIMEOUT_S)

    async def _fetch_crypto(self) -> object:
        return await self._get_json(
            _CRYPTO_URL, headers=_CRYPTO_HEADERS, timeout_s=_CRYPTO_TIMEOUT_S
        )

    async def _get_json(self, url: str, *, headers: dict[str, str], timeout_s: float) -> object:
        session = self._http()
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as response:
            response.raise_for_status()
            return await response.json(content_type=None)

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            context = ssl.create_default_context(cafile=certifi.where())
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=context)
            )
        return self._session
