"""Option gamma exposure (GEX) and put/call open interest from delayed public chains.

Both sources feed the model in ``core/gex.py``, which multiplies every contract by
100 shares. The two venues differ:

- US stocks (Cboe delayed quotes): a contract symbol is ``ROOT + YYMMDD + C|P +
  strike * 1000`` in 8 digits. Adjusted contracts carry another root and are
  dropped. Expiry is 16:00 New York time. One contract is 100 shares.
- BTC and ETH (Deribit book summary): ``BTC-29JAN27-72000-C``. Expiry is 08:00 UTC.
  One contract is 1 coin. The model's 100 multiplier is removed from ``netGex`` by
  scaling it with ``1 / 100`` (``contract_size / model multiplier``), so the figure
  is USD for 1-coin contracts. Walls, the flip and max pain do not depend on that
  scale.

Max pain is taken for the nearest standard monthly expiry: the third Friday for US
stocks (Cboe's monthly), the last Friday for Deribit (Deribit's monthly, for example
27 Nov 2026). This is a deliberate departure from a third-Friday rule for Deribit: the
third Friday is not a Deribit monthly, so it would almost never have rows. The expiry
comes from the calendar, so a monthly missing from the chain gives None rather than a
later one.

Data (both sections; keys are camelCase): ``spot`` (USD: the stock price, or for
Deribit the first row's ``estimated_delivery_price``, which is per expiry and differs by
about a dollar between expiries), ``netGex`` (USD), ``callWall``, ``putWall``,
``gammaFlip`` (None without a sign bracket), ``putCallOiRatio`` (None without call open
interest), ``contracts`` and ``expiries`` (integer counts of rows and distinct expiries
used), ``maxPain`` and ``maxPainExpiry`` (both None when that monthly has no rows),
``currency`` ("USD").

Failures: a Cboe 404 is an unlisted ticker (``not_applicable``). A Cboe 403 is raised,
not read as unlisted: it may be a rate limit or a block, so the drawer says Cboe refused
the request and the symbol may have no listed options. A reply without a positive price
or a timestamp, and a Deribit reply without a price, raise ``ValueError``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, tzinfo
import math
import re
import time
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp

from flowmap_server.core.gex import OptionContract, calculate_gex
from flowmap_server.research.base import Http, SectionResult, result

__all__ = [
    "OptionsSource",
    "days_to_expiry",
    "last_friday",
    "max_pain",
    "parse_deribit_name",
    "parse_occ_symbol",
    "put_call_oi_ratio",
    "third_friday",
]

CBOE_URL = "https://cdn.cboe.com/api/global/delayed_quotes/options"
CBOE_CAP_BYTES = 40 * 1024 * 1024
CBOE_TIMEOUT_S = 25.0
DERIBIT_URL = "https://www.deribit.com/api/v2/public/get_book_summary_by_currency"
DERIBIT_CAP_BYTES = 8 * 1024 * 1024
DERIBIT_COINS = frozenset({"BTC", "ETH"})
NEW_YORK = ZoneInfo("America/New_York")
# The HTTP answer that means "this ticker has no listed options". Cboe answers 404 for an
# unlisted ticker. A 403 is a refusal (rate limit or block) and is raised, not read as unlisted.
UNLISTED_STATUS = 404
STOCK_SECTION = "gex"
CRYPTO_SECTION = "options"
_OCC_TAIL = re.compile(r"(\d{2})(\d{2})(\d{2})([CP])(\d{8})")
_SECONDS_PER_DAY = 86400.0


@dataclass(frozen=True, slots=True)
class Venue:
    """Venue conventions: the source name, expiry clock, monthly rule and contract size."""

    source: str
    zone: tzinfo
    expiry_hour: int
    monthly: Callable[[int, int], date]
    contract_size: float  # Units of the underlying per listed contract.


@dataclass(frozen=True, slots=True)
class _Row:
    """One contract that passed the filters: open interest > 0, IV > 0, not expired."""

    expiry: date
    strike: float
    is_call: bool
    open_interest: float
    implied_vol: float
    dte_days: float


def _nth_friday(year: int, month: int, n: int) -> date:
    first = date(year, month, 1)
    offset = (4 - first.weekday()) % 7  # Friday is weekday 4.
    return first + timedelta(days=offset + 7 * (n - 1))


def third_friday(year: int, month: int) -> date:
    """The third Friday of the month (the standard US listed monthly)."""
    return _nth_friday(year, month, 3)


def last_friday(year: int, month: int) -> date:
    """The last Friday of the month (the Deribit monthly)."""
    next_month = date(year + (month == 12), month % 12 + 1, 1)
    last = next_month - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - 4) % 7)


CBOE_VENUE = Venue("Cboe delayed options", NEW_YORK, 16, third_friday, 100.0)
DERIBIT_VENUE = Venue("Deribit", UTC, 8, last_friday, 1.0)


def parse_occ_symbol(raw: str, root: str) -> tuple[date, bool, float] | None:
    """Expiry, is-call and strike of a contract whose root is ``root``; None otherwise.

    The last 15 characters are ``YYMMDD``, ``C|P`` and an 8-digit strike times 1000.
    Everything before them is the root, which must equal ``root`` exactly.
    """
    if len(raw) <= 15 or raw[:-15] != root:
        return None
    match = _OCC_TAIL.fullmatch(raw[-15:])
    if match is None:
        return None
    yy, mm, dd, side, strike8 = match.groups()
    try:
        expiry = date(2000 + int(yy), int(mm), int(dd))
    except ValueError:
        return None
    return expiry, side == "C", int(strike8) / 1000.0


def parse_deribit_name(name: str, base: str) -> tuple[date, bool, float] | None:
    """Expiry, is-call and strike of ``BASE-DDMMMYY-STRIKE-C|P``; None for futures and perps."""
    parts = name.split("-")
    if len(parts) != 4 or parts[0] != base or parts[3] not in ("C", "P"):
        return None
    try:
        expiry = datetime.strptime(parts[1], "%d%b%y").date()
        strike = float(parts[2])
    except ValueError:
        return None
    return expiry, parts[3] == "C", strike


def days_to_expiry(quote_at: datetime, expires_at: datetime) -> float:
    """Elapsed days between two aware instants, computed in UTC across DST changes."""
    elapsed = expires_at.astimezone(UTC) - quote_at.astimezone(UTC)
    return elapsed.total_seconds() / _SECONDS_PER_DAY


def put_call_oi_ratio(rows: Iterable[_Row]) -> float | None:
    """Put open interest over call open interest; None when there is no call open interest."""
    calls = 0.0
    puts = 0.0
    for row in rows:
        if row.is_call:
            calls += row.open_interest
        else:
            puts += row.open_interest
    return puts / calls if calls > 0 else None


def max_pain(rows: Iterable[_Row]) -> float | None:
    """The strike at which the holders' total intrinsic value is smallest.

    Candidates are the listed strikes. A tie goes to the lower strike.
    """
    chain = list(rows)
    if not chain:
        return None
    best_strike: float | None = None
    best_paid = math.inf
    for settle in sorted({row.strike for row in chain}):
        paid = 0.0
        for row in chain:
            if row.is_call:
                paid += row.open_interest * max(settle - row.strike, 0.0)
            else:
                paid += row.open_interest * max(row.strike - settle, 0.0)
        if paid < best_paid:
            best_paid = paid
            best_strike = settle
    return best_strike


def _expiry_at(venue: Venue, day: date) -> datetime:
    return datetime(day.year, day.month, day.day, venue.expiry_hour, tzinfo=venue.zone)


def _nearest_monthly(venue: Venue, quote_at: datetime) -> date:
    """The first standard monthly whose expiry instant is after the quote."""
    local = quote_at.astimezone(venue.zone)
    year, month = local.year, local.month
    quote_utc = quote_at.astimezone(UTC)
    for _ in range(36):
        day = venue.monthly(year, month)
        if _expiry_at(venue, day).astimezone(UTC) > quote_utc:
            return day
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    raise ValueError("no monthly expiry in the next three years")


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _positive(value: object) -> float | None:
    number = _number(value)
    return number if number is not None and number > 0 else None


def _mapping(value: object) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError("expected an object")
    return value


def _cboe_timestamp(value: object) -> datetime:
    """The quote time, read as New York local time ("2026-11-14 22:24:14")."""
    if not isinstance(value, str):
        raise ValueError("Cboe reply has no timestamp")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d %H:%M:%S")
    except ValueError as exc:
        raise ValueError("Cboe reply has an unreadable timestamp") from exc
    return parsed.replace(tzinfo=NEW_YORK)


def _sequence(value: object) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError("expected a list")
    return value


def _cboe_rows(items: list[Any], root: str, quote_at: datetime) -> list[_Row]:
    rows: list[_Row] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        parsed = parse_occ_symbol(str(item.get("option", "")), root)
        open_interest = _number(item.get("open_interest"))
        implied_vol = _number(item.get("iv"))
        if parsed is None or open_interest is None or implied_vol is None:
            continue
        if open_interest <= 0 or implied_vol <= 0:
            continue
        expiry, is_call, strike = parsed
        dte = days_to_expiry(quote_at, _expiry_at(CBOE_VENUE, expiry))
        if dte <= 0:
            continue
        rows.append(_Row(expiry, strike, is_call, open_interest, implied_vol, dte))
    return rows


def _deribit_rows(items: list[Any], base: str, quote_at: datetime) -> list[_Row]:
    rows: list[_Row] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        parsed = parse_deribit_name(str(item.get("instrument_name", "")), base)
        open_interest = _number(item.get("open_interest"))
        mark_iv = _number(item.get("mark_iv"))
        if parsed is None or open_interest is None or mark_iv is None:
            continue
        if open_interest <= 0 or mark_iv <= 0:
            continue
        expiry, is_call, strike = parsed
        dte = days_to_expiry(quote_at, _expiry_at(DERIBIT_VENUE, expiry))
        if dte <= 0:
            continue
        rows.append(_Row(expiry, strike, is_call, open_interest, mark_iv / 100.0, dte))
    return rows


def _gex_result(
    venue: Venue,
    section: str,
    symbol: str,
    spot: float,
    quote_at: datetime,
    rows: list[_Row],
    fetched_ns: int,
) -> SectionResult:
    contracts = [
        OptionContract(row.strike, row.is_call, row.open_interest, row.implied_vol, row.dte_days)
        for row in rows
    ]
    model = calculate_gex(symbol, spot, contracts)
    if not model.available:
        return result(section, symbol, "empty", source=venue.source, fetched_ns=fetched_ns,
                      reason=model.unavailable_reason)
    # The model applies MODEL_MULTIPLIER per contract; rescale to the venue's contract size.
    scale = venue.contract_size / float(model.model_provenance["contract_multiplier"])
    expiry = _nearest_monthly(venue, quote_at)
    chain = [row for row in rows if row.expiry == expiry]
    data: dict[str, Any] = {
        "spot": spot,
        "netGex": model.net_gex * scale if model.net_gex is not None else None,
        "callWall": model.call_wall,
        "putWall": model.put_wall,
        "gammaFlip": model.gamma_flip,
        "putCallOiRatio": put_call_oi_ratio(rows),
        "contracts": len(rows),
        "expiries": len({row.expiry for row in rows}),
        "maxPain": max_pain(chain) if chain else None,
        "maxPainExpiry": expiry.isoformat() if chain else None,
        "currency": "USD",
    }
    return result(
        section, symbol, "ok", source=venue.source, fetched_ns=fetched_ns,
        as_of=quote_at.astimezone(venue.zone).date().isoformat(), data=data,
    )


class OptionsSource:
    """GEX sections from the Cboe delayed chain (stocks) and Deribit (BTC, ETH)."""

    def __init__(self, http: Http, *, clock: Callable[[], int] = time.time_ns) -> None:
        self._http = http
        self._clock = clock

    async def equity_gex(self, symbol: str) -> SectionResult:
        """GEX for a US ticker from its Cboe delayed chain; ``symbol`` is a ``us_symbol``."""
        fetched = self._clock()
        try:
            body = await self._http.get_json(
                f"{CBOE_URL}/{symbol}.json", limit=CBOE_CAP_BYTES, timeout_s=CBOE_TIMEOUT_S
            )
        except aiohttp.ClientResponseError as exc:
            if exc.status == UNLISTED_STATUS:
                return result(STOCK_SECTION, symbol, "not_applicable", source=CBOE_VENUE.source,
                              fetched_ns=fetched, reason="no_listed_options")
            raise
        document = _mapping(body)
        quote_at = _cboe_timestamp(document.get("timestamp"))
        block = _mapping(document.get("data"))
        spot = _positive(block.get("current_price"))
        if spot is None:
            raise ValueError("Cboe reply has no positive current_price")
        # Parsing a large chain and running the model is CPU work: keep it off the event loop.
        rows = await asyncio.to_thread(_cboe_rows, _sequence(block.get("options")), symbol.replace(".", ""), quote_at)
        return await asyncio.to_thread(_gex_result, CBOE_VENUE, STOCK_SECTION, symbol, spot, quote_at, rows, fetched)

    async def crypto_gex(self, base: str) -> SectionResult:
        """GEX for BTC or ETH from the Deribit book summary; other coins are not applicable.

        ``base`` is taken in upper case. A Deribit reply without a positive price raises.
        """
        base = base.upper()
        fetched = self._clock()
        if base not in DERIBIT_COINS:
            return result(CRYPTO_SECTION, base, "not_applicable", source=DERIBIT_VENUE.source,
                          fetched_ns=fetched, reason="no_options_market")
        body = await self._http.get_json(
            DERIBIT_URL, limit=DERIBIT_CAP_BYTES, params={"currency": base, "kind": "option"}
        )
        items = _sequence(_mapping(body).get("result"))
        if not items:
            return result(CRYPTO_SECTION, base, "empty", source=DERIBIT_VENUE.source,
                          fetched_ns=fetched, reason="no_listed_options")
        stamps = [_number(_mapping(item).get("creation_timestamp")) for item in items]
        known = [stamp for stamp in stamps if stamp is not None]
        if not known:
            raise ValueError("no creation_timestamp in the Deribit summary")
        # The newest row's time is the observation time for every contract's expiry.
        quote_at = datetime.fromtimestamp(max(known) / 1000.0, UTC)
        # estimated_delivery_price is per expiry (about a dollar apart), not one index print:
        # the first row's value is used, as the brief asks.
        spot = next(
            (value for value in (_positive(_mapping(item).get("estimated_delivery_price"))
                                 for item in items) if value is not None),
            None,
        )
        if spot is None:
            raise ValueError("Deribit summary has no positive estimated_delivery_price")
        rows = await asyncio.to_thread(_deribit_rows, items, base, quote_at)
        return await asyncio.to_thread(_gex_result, DERIBIT_VENUE, CRYPTO_SECTION, base, spot, quote_at, rows, fetched)

    async def close(self) -> None:
        return None
