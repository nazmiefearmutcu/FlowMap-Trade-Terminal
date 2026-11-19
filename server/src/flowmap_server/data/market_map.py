"""Market map data: parse two public screeners and serve them from a short cache.

US stocks come from the Nasdaq public screener and crypto from CoinGecko. Both
are keyless. The parsers turn a raw payload into map tiles (symbol, name, group,
market cap, price, change, volume and an optional chart symbol). The service
keeps each answer for a minute, and when a refresh fails it serves the last good
answer marked stale instead of an error.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import ssl
import time
from collections.abc import Awaitable, Callable, Collection
from typing import Protocol

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
# Binance's list of spot prices, used to tell which coins have a USDT chart pair.
_BINANCE_PAIRS_URL = "https://api.binance.com/api/v3/ticker/price"
_BINANCE_TIMEOUT_S = 8.0
BINANCE_BODY_LIMIT = 2 * 1024 * 1024
# The pair list changes slowly, so it is kept for six hours. A failed refresh is
# not retried for five minutes.
PAIRS_TTL_S = 6 * 3600.0
PAIRS_RETRY_S = 300.0
# Largest response body the parsers will read. The Nasdaq list is about 2 MB
# today; the cap leaves room for growth and refuses anything runaway.
US_BODY_LIMIT = 8 * 1024 * 1024
CRYPTO_BODY_LIMIT = 2 * 1024 * 1024
_READ_CHUNK = 64_000
_CRYPTO_URL = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd&order=market_cap_desc&per_page=250&page=1"
    "&price_change_percentage=1h,24h,7d"
)
_CRYPTO_HEADERS = {"Accept": "application/json"}
_CRYPTO_TIMEOUT_S = 8.0

# Share-class and listing descriptions that make a tile label noisy. The name is
# cut at the first one that appears as a whole word, so "Class Assets" survives.
_US_NAME_CUT = re.compile(
    r" (?:Common Stock|Class [ABC]|American Depositary|Ordinary Shares|Depositary Shares)"
    r"(?![A-Za-z])"
)
_CHART_SYMBOL = re.compile(r"[A-Z0-9.\-]+")

# Stablecoins, tokenised cash funds and wrapped or staked duplicates of a coin
# that is already listed. Gold tokens (PAXG, XAUT) are not dollar-pegged, so they
# stay in.
EXCLUDED_COINS: frozenset[str] = frozenset({
    "USDT", "USDC", "DAI", "USDS", "USDE", "FDUSD", "PYUSD", "TUSD", "USD1", "USDD",
    "BUSD", "USDT0", "RLUSD", "USDF", "USDG", "BSC-USD", "WBTC", "WETH", "WEETH",
    "STETH", "WSTETH", "CBBTC", "CBETH", "RETH", "WBETH", "LBTC", "JITOSOL", "BNSOL",
    "MSOL", "SUSDE", "SUSDS", "BUIDL", "USDTB",
    "USDY", "USYC", "EURC", "EURS", "EURT", "USD0", "USDX", "USDB", "BFUSD", "GHO",
    "CRVUSD", "FRAX", "FRXUSD", "LUSD", "USDP", "GUSD", "USTB", "OUSG", "USDO", "USX",
    "SYRUPUSDC", "SYRUPUSDT", "USDA", "USR", "DOLA", "MIM", "USDL", "AUSD", "FRXETH",
    "SFRXETH", "METH", "EZETH", "RSETH", "OSETH", "SWETH", "ETHX", "SOLVBTC", "TBTC",
    "FBTC", "WBNB", "STKAAVE",
})
# A dollar stablecoin the list does not know yet: a "USD" word in the name and a
# price this close to one dollar.
_USD_WORD = re.compile(r"\bUSD\b", re.IGNORECASE)
_DOLLAR_PRICE_LOW = 0.98
_DOLLAR_PRICE_HIGH = 1.02
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
    """A finite float from a number or a string such as ``"$1,234.50"``, else None.

    A JSON integer too large for a float (OverflowError) counts as unusable, so
    one bad cell skips only its own value.
    """
    if isinstance(value, bool):
        return None
    try:
        if isinstance(value, str):
            text = value.strip().replace("$", "").replace(",", "").replace("%", "")
            if not text:
                return None
            number = float(text)
        elif isinstance(value, (int, float)):
            number = float(value)
        else:
            return None
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def clean_company_name(name: str, symbol: str) -> str:
    match = _US_NAME_CUT.search(name)
    cut = name[: match.start()] if match else name
    return cut.strip() or symbol


class _Stream(Protocol):
    async def read(self, n: int = -1) -> bytes: ...


class _Body(Protocol):
    """The part of an aiohttp response the bounded reader needs."""

    @property
    def content_length(self) -> int | None: ...

    @property
    def content(self) -> _Stream: ...


async def read_capped_bytes(response: _Body, *, limit: int) -> bytes:
    """Read a body no larger than ``limit`` bytes.

    A declared Content-Length above the limit is refused before anything is read.
    Otherwise the body is read in chunks and the read stops as soon as it passes
    the limit, so an undeclared or lying length cannot buffer more than that.
    """
    declared = response.content_length
    if declared is not None and declared > limit:
        raise ValueError(f"response declares {declared} bytes, over the {limit} byte limit")
    body = bytearray()
    while True:
        chunk = await response.content.read(_READ_CHUNK)
        if not chunk:
            break
        body += chunk
        if len(body) > limit:
            raise ValueError(f"response body is over the {limit} byte limit")
    return bytes(body)


async def read_capped_json(response: _Body, *, limit: int) -> object:
    """Decode a JSON body no larger than ``limit`` bytes (see ``read_capped_bytes``)."""
    return json.loads(await read_capped_bytes(response, limit=limit))


def _describe(exc: Exception) -> str:
    """The exception type, plus the HTTP status for an HTTP error.

    An aiohttp error's text carries the full request URL, query string included,
    so it is never logged. Other exceptions keep their message, which this module
    writes itself.
    """
    if isinstance(exc, aiohttp.ClientResponseError):
        return f"{type(exc).__name__} (HTTP {exc.status})"
    if isinstance(exc, aiohttp.ClientError):
        return type(exc).__name__
    return f"{type(exc).__name__}: {exc}"


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
        name=clean_company_name(_text(row.get("name")), symbol),
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


def parse_usdt_pairs(payload: object) -> frozenset[str]:
    """The ``*USDT`` symbols from Binance's ticker list, e.g. ``BTCUSDT``.

    Raises ``ValueError`` when the payload is not a list, a row has no string
    symbol, or no USDT pair is present.
    """
    if not isinstance(payload, list):
        raise ValueError("Binance ticker payload is not a list")
    pairs: set[str] = set()
    for row in payload:
        if not isinstance(row, dict) or not isinstance(row.get("symbol"), str):
            raise ValueError("Binance ticker row has no string symbol")
        if row["symbol"].endswith("USDT"):
            pairs.add(row["symbol"])
    if not pairs:
        raise ValueError("Binance ticker payload has no USDT pairs")
    return frozenset(pairs)


def _coin_item(row: object, known_pairs: Collection[str]) -> MapItem | None:
    if not isinstance(row, dict):
        return None
    symbol = _text(row.get("symbol")).upper()
    if not symbol or symbol in EXCLUDED_COINS:
        return None
    name = _text(row.get("name"))
    market_cap = _number(row.get("market_cap"))
    price = _number(row.get("current_price"))
    if market_cap is None or market_cap <= 0 or price is None or price <= 0:
        return None
    if _DOLLAR_PRICE_LOW <= price <= _DOLLAR_PRICE_HIGH and _USD_WORD.search(name):
        return None
    change: dict[str, float] = {}
    for period, field in _CRYPTO_PERIODS:
        value = _number(row.get(field))
        if value is not None:
            change[period] = value
    pair = f"{symbol}USDT"
    return MapItem(
        symbol=symbol,
        name=name or symbol,
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
        fetch_pairs: Callable[[], Awaitable[object]] | None = None,
        clock: Callable[[], int] = time.time_ns,
        monotonic: Callable[[], float] = time.monotonic,
        ttl_s: float = CACHE_TTL_S,
    ) -> None:
        self._fetchers: dict[str, Callable[[], Awaitable[object]]] = {
            "us": fetch_us or self._fetch_us,
            "crypto": fetch_crypto or self._fetch_crypto,
        }
        self._pairs_fetcher = fetch_pairs or self._fetch_binance_pairs
        self._clock = clock
        self._monotonic = monotonic
        self._ttl_s = ttl_s
        # market -> (answer, monotonic time it was fetched)
        self._answers: dict[str, tuple[MarketMap, float]] = {}
        self._failed_at: dict[str, float] = {}
        self._locks = {market: asyncio.Lock() for market in _SOURCE_NAMES}
        self._refreshes: dict[str, asyncio.Task[MarketMap | None]] = {}
        # The learned USDT pair set, when it was fetched, and when a refresh last failed.
        self._pairs: frozenset[str] | None = None
        self._pairs_fetched_at: float | None = None
        self._pairs_failed_at: float | None = None
        self._pairs_lock = asyncio.Lock()
        self._session: aiohttp.ClientSession | None = None

    async def get(self, market: str, *, allow_stale: bool = False) -> MarketMap:
        if market not in _SOURCE_NAMES:
            raise ValueError(f"unknown market {market!r}")
        fresh = self._fresh(market)
        if fresh is not None:
            return fresh
        if allow_stale and market in self._answers:
            refresh = self._refreshes.get(market)
            if (refresh is None or refresh.done()) and self._can_refresh(market):
                self._refreshes[market] = asyncio.create_task(self._refresh_cached(market))
            return self._fallback(market)
        async with self._locks[market]:
            fresh = self._fresh(market)
            if fresh is not None:
                return fresh
            if self._can_refresh(market):
                try:
                    items = await self._load(market)
                except Exception as exc:
                    self._failed_at[market] = self._monotonic()
                    logger.warning("market map refresh for %s failed: %s", market, _describe(exc))
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

    def _can_refresh(self, market: str) -> bool:
        failed_at = self._failed_at.get(market)
        return failed_at is None or self._monotonic() - failed_at >= RETRY_AFTER_FAILURE_S

    async def _refresh_cached(self, market: str) -> MarketMap | None:
        try:
            return await self.get(market)
        except MarketMapUnavailable:
            return None

    async def close(self) -> None:
        tasks = list(self._refreshes.values())
        self._refreshes.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
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
        if market == "us":
            return parse_us(await self._fetchers[market]())
        payload, pairs = await asyncio.gather(self._fetchers[market](), self._usdt_pairs())
        return parse_crypto(payload, known_pairs=pairs)

    async def _usdt_pairs(self) -> frozenset[str]:
        """The USDT pairs a coin can chart against. Never raises.

        The list is refreshed every ``PAIRS_TTL_S``. A failed refresh keeps the
        previous list, or the bundled shortlist when there is none, and is not
        retried for ``PAIRS_RETRY_S``.
        """
        if self._pairs is not None and self._pairs_fresh():
            return self._pairs
        async with self._pairs_lock:
            if self._pairs is not None and self._pairs_fresh():
                return self._pairs
            failed_at = self._pairs_failed_at
            if failed_at is None or self._monotonic() - failed_at >= PAIRS_RETRY_S:
                try:
                    pairs = parse_usdt_pairs(await self._pairs_fetcher())
                except Exception as exc:
                    self._pairs_failed_at = self._monotonic()
                    logger.warning("binance pair list refresh failed: %s", _describe(exc))
                else:
                    self._pairs = pairs
                    self._pairs_fetched_at = self._monotonic()
                    self._pairs_failed_at = None
                    return pairs
            return self._pairs if self._pairs is not None else frozenset(CRYPTO_SYMBOLS)

    def _pairs_fresh(self) -> bool:
        fetched_at = self._pairs_fetched_at
        return fetched_at is not None and self._monotonic() - fetched_at < PAIRS_TTL_S

    async def _fetch_binance_pairs(self) -> object:
        return await self._get_json(
            _BINANCE_PAIRS_URL, headers=_CRYPTO_HEADERS, timeout_s=_BINANCE_TIMEOUT_S,
            limit=BINANCE_BODY_LIMIT,
        )

    async def _fetch_us(self) -> object:
        return await self._get_json(
            _US_URL, headers=_US_HEADERS, timeout_s=_US_TIMEOUT_S, limit=US_BODY_LIMIT
        )

    async def _fetch_crypto(self) -> object:
        return await self._get_json(
            _CRYPTO_URL, headers=_CRYPTO_HEADERS, timeout_s=_CRYPTO_TIMEOUT_S,
            limit=CRYPTO_BODY_LIMIT,
        )

    async def _get_json(
        self, url: str, *, headers: dict[str, str], timeout_s: float, limit: int
    ) -> object:
        session = self._http()
        async with session.get(
            url, headers=headers, timeout=aiohttp.ClientTimeout(total=timeout_s)
        ) as response:
            response.raise_for_status()
            return await read_capped_json(response, limit=limit)

    def _http(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            context = ssl.create_default_context(cafile=certifi.where())
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=context)
            )
        return self._session
