"""Market map parsing and the cached service, with no network.

The parsers run on the trimmed real payloads under ``tests/api/fixtures`` and on
small inline rows where an exact value is asserted. The service runs against
fake fetchers and an injected monotonic clock.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flowmap_server.data.market_map import (
    CRYPTO_LIMIT,
    CRYPTO_SOURCE,
    US_SOURCE,
    MarketMapService,
    MarketMapUnavailable,
    parse_crypto,
    parse_us,
)
from flowmap_server.data.universe import CRYPTO_MARKET

FIXTURES = Path(__file__).resolve().parents[1] / "api" / "fixtures" / "market_map"
NASDAQ = json.loads((FIXTURES / "nasdaq_screener.json").read_text(encoding="utf-8"))
COINGECKO = json.loads((FIXTURES / "coingecko_markets.json").read_text(encoding="utf-8"))
NOW_NS = 1_700_000_000_123_456_789


def _row(
    symbol: str = "ABC",
    name: str = "Abc Holdings Inc.",
    lastsale: str = "$10.00",
    pctchange: str = "1.00%",
    market_cap: str = "1000000.00",
    sector: str = "Technology",
    volume: str = "500",
) -> dict[str, str]:
    return {
        "symbol": symbol,
        "name": name,
        "lastsale": lastsale,
        "netchange": "0.10",
        "pctchange": pctchange,
        "volume": volume,
        "marketCap": market_cap,
        "country": "United States",
        "sector": sector,
        "industry": "Testing",
    }


def _us(*rows: dict[str, str]) -> dict[str, object]:
    return {"data": {"rows": list(rows)}}


def _coin(
    symbol: str = "btc",
    name: str = "Bitcoin",
    price: float | None = 68000.0,
    cap: float | None = 1.3e12,
    volume: float | None = 4.3e10,
    h1: float | None = 0.1,
    h24: float | None = -4.2,
    d7: float | None = 3.0,
) -> dict[str, object]:
    return {
        "symbol": symbol,
        "name": name,
        "current_price": price,
        "market_cap": cap,
        "total_volume": volume,
        "price_change_percentage_1h_in_currency": h1,
        "price_change_percentage_24h_in_currency": h24,
        "price_change_percentage_7d_in_currency": d7,
    }


# --- US parsing ----------------------------------------------------------------


def test_us_fixture_is_sorted_by_market_cap_with_the_big_three_first():
    items = parse_us(NASDAQ)
    assert [i.symbol for i in items[:3]] == ["AAPL", "NVDA", "MSFT"]
    caps = [i.market_cap for i in items]
    assert caps == sorted(caps, reverse=True)


def test_us_fixture_drops_rows_with_an_empty_market_cap():
    empty = {r["symbol"] for r in NASDAQ["data"]["rows"] if not r.get("marketCap")}
    assert empty  # the fixture really has such rows
    symbols = {i.symbol for i in parse_us(NASDAQ)}
    assert not (empty & symbols)


def test_us_limit_keeps_that_many_rows():
    assert len(parse_us(NASDAQ, limit=10)) == 10


def test_us_parses_price_change_and_volume_from_strings():
    item = parse_us(_us(_row(lastsale="$1,234.50", pctchange="-2.21%", volume="1714820")))[0]
    assert item.price == 1234.5
    assert item.change == {"1d": -2.21}
    assert item.volume == 1714820.0
    assert item.market_cap == 1_000_000.0
    assert item.group == "Technology"


def test_us_unparsable_change_leaves_the_1d_key_out():
    item = parse_us(_us(_row(pctchange="n/a")))[0]
    assert item.change == {}
    blank = parse_us(_us(_row(pctchange="")))[0]
    assert blank.change == {}


def test_us_empty_sector_becomes_other():
    assert parse_us(_us(_row(sector="")))[0].group == "Other"


def test_us_unusable_numbers_skip_the_row():
    rows = [
        _row(symbol="NOCAP", market_cap=""),
        _row(symbol="ZEROCAP", market_cap="0"),
        _row(symbol="NANCAP", market_cap="nan"),
        _row(symbol="INFCAP", market_cap="inf"),
        _row(symbol="NOPRICE", lastsale=""),
        _row(symbol="ZEROPRICE", lastsale="$0.00"),
        _row(symbol="", market_cap="5"),
        _row(symbol="GOOD"),
    ]
    assert [i.symbol for i in parse_us(_us(*rows))] == ["GOOD"]


def test_us_name_suffixes_are_cut():
    names = [
        "Agilent Technologies Inc. Common Stock",
        "Alphabet Inc. Class A Common Stock",
        "Berkshire Hathaway Inc. Class B Common Stock",
        "Some Plc American Depositary Shares",
        "Foo Ltd Ordinary Shares",
        "Bar Corp Depositary Shares",
    ]
    rows = [_row(symbol=f"S{i}", name=n, market_cap=str(1000 - i)) for i, n in enumerate(names)]
    got = [i.name for i in parse_us(_us(*rows))]
    assert got == [
        "Agilent Technologies Inc.",
        "Alphabet Inc.",
        "Berkshire Hathaway Inc.",
        "Some Plc",
        "Foo Ltd",
        "Bar Corp",
    ]


def test_us_share_class_symbol_charts_with_a_dot():
    item = parse_us(_us(_row(symbol="BRK/B")))[0]
    assert item.symbol == "BRK/B"
    assert item.chart == {"market": "equity", "symbol": "BRK.B"}


def test_us_symbol_with_a_space_has_no_chart():
    item = parse_us(_us(_row(symbol="FOO BAR")))[0]
    assert item.chart is None


def test_us_plain_symbol_charts_as_equity():
    assert parse_us(_us(_row(symbol="AAPL")))[0].chart == {"market": "equity", "symbol": "AAPL"}


def test_us_sorts_ties_by_symbol():
    rows = [_row(symbol="ZZZ", market_cap="500"), _row(symbol="AAA", market_cap="500")]
    assert [i.symbol for i in parse_us(_us(*rows))] == ["AAA", "ZZZ"]


# --- crypto parsing ------------------------------------------------------------


def test_crypto_fixture_excludes_stablecoins_and_leads_with_btc():
    items = parse_crypto(COINGECKO)
    symbols = [i.symbol for i in items]
    assert symbols[0] == "BTC"
    assert "USDT" not in symbols
    assert "USDC" not in symbols
    assert len(items) <= CRYPTO_LIMIT


def test_crypto_symbols_are_upper_case_and_group_is_crypto():
    for item in parse_crypto(COINGECKO):
        assert item.symbol == item.symbol.upper()
        assert item.group == "Crypto"


def test_crypto_change_has_three_periods_and_null_periods_are_left_out():
    btc = parse_crypto([_coin()])[0]
    assert btc.change == {"1h": 0.1, "24h": -4.2, "7d": 3.0}
    partial = parse_crypto([_coin(d7=None)])[0]
    assert partial.change == {"1h": 0.1, "24h": -4.2}


def test_crypto_fields_map_to_price_cap_volume_and_name():
    btc = parse_crypto([_coin(name="Bitcoin", price=68000.0, cap=1.3e12, volume=4.3e10)])[0]
    assert btc.name == "Bitcoin"
    assert btc.price == 68000.0
    assert btc.market_cap == 1.3e12
    assert btc.volume == 4.3e10


def test_crypto_null_volume_is_none():
    assert parse_crypto([_coin(volume=None)])[0].volume is None


def test_crypto_chart_is_the_usdt_pair_only_when_known():
    row = [_coin(symbol="eth")]
    known = parse_crypto(row, known_pairs=("ETHUSDT",))[0]
    assert known.chart == {"market": CRYPTO_MARKET, "symbol": "ETHUSDT"}
    unknown = parse_crypto(row, known_pairs=("BTCUSDT",))[0]
    assert unknown.chart is None


def test_crypto_skips_unusable_rows():
    rows = [
        _coin(symbol="", name="No symbol"),
        _coin(symbol="xx", cap=None),
        _coin(symbol="yy", cap=0),
        _coin(symbol="zz", price=None),
        _coin(symbol="ww", price=-1.0),
        _coin(symbol="eth"),
    ]
    assert [i.symbol for i in parse_crypto(rows)] == ["ETH"]


def test_crypto_excludes_wrapped_and_staked_duplicates():
    rows = [_coin(symbol=s, cap=1e9 - i) for i, s in enumerate(["wbtc", "steth", "usdc", "ada"])]
    assert [i.symbol for i in parse_crypto(rows)] == ["ADA"]


def test_crypto_limit_keeps_that_many_rows():
    rows = [_coin(symbol=f"c{i}", cap=1e9 - i) for i in range(20)]
    assert len(parse_crypto(rows, limit=5)) == 5


# --- bad payloads --------------------------------------------------------------


@pytest.mark.parametrize("payload", [None, {}, {"data": {}}, [], [1, "x", None], {"data": {"rows": 3}}])
def test_us_bad_payload_raises_value_error(payload):
    with pytest.raises(ValueError):
        parse_us(payload)


def test_us_payload_with_no_usable_row_raises_value_error():
    with pytest.raises(ValueError):
        parse_us(_us(_row(market_cap="")))


@pytest.mark.parametrize("payload", [None, {}, {"data": {}}, "text", [1, "x"]])
def test_crypto_bad_payload_raises_value_error(payload):
    with pytest.raises(ValueError):
        parse_crypto(payload)


def test_crypto_list_with_no_usable_row_raises_value_error():
    with pytest.raises(ValueError):
        parse_crypto([_coin(cap=None)])


# --- service -------------------------------------------------------------------


class _Mono:
    def __init__(self, t: float = 1000.0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t


class _Source:
    """A fake fetcher that counts calls and can be told to fail."""

    def __init__(self, payload: object, delay: float = 0.0) -> None:
        self.payload = payload
        self.delay = delay
        self.fail = False
        self.calls = 0

    async def __call__(self) -> object:
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail:
            raise RuntimeError("upstream exploded")
        return self.payload


def _service(us: _Source | None = None, crypto: _Source | None = None,
             mono: _Mono | None = None) -> MarketMapService:
    return MarketMapService(
        fetch_us=us or _Source(NASDAQ),
        fetch_crypto=crypto or _Source(COINGECKO),
        clock=lambda: NOW_NS,
        monotonic=mono or _Mono(),
        ttl_s=60.0,
    )


async def test_service_serves_a_fresh_answer_without_fetching_again():
    us = _Source(NASDAQ)
    svc = _service(us=us)
    first = await svc.get("us")
    second = await svc.get("us")
    assert us.calls == 1
    assert first == second
    assert first.market == "us"
    assert first.source == US_SOURCE
    assert first.stale is False
    assert first.as_of_ns == NOW_NS
    assert first.items[0].symbol == "AAPL"


async def test_service_fetches_again_after_the_ttl():
    us = _Source(NASDAQ)
    mono = _Mono()
    svc = _service(us=us, mono=mono)
    await svc.get("us")
    mono.t += 59.0
    await svc.get("us")
    assert us.calls == 1
    mono.t += 2.0
    await svc.get("us")
    assert us.calls == 2


async def test_service_failed_refresh_returns_the_old_answer_as_stale():
    us = _Source(NASDAQ)
    mono = _Mono()
    svc = _service(us=us, mono=mono)
    first = await svc.get("us")
    mono.t += 61.0
    us.fail = True
    stale = await svc.get("us")
    assert stale.stale is True
    assert stale.items == first.items
    assert stale.source == US_SOURCE


async def test_service_failed_first_fetch_raises_unavailable_without_url_or_traceback():
    us = _Source(NASDAQ)
    us.fail = True
    svc = _service(us=us)
    with pytest.raises(MarketMapUnavailable) as info:
        await svc.get("us")
    message = str(info.value)
    assert US_SOURCE in message
    assert "://" not in message
    assert "?" not in message
    assert "Traceback" not in message


async def test_service_concurrent_callers_share_one_fetch():
    us = _Source(NASDAQ, delay=0.01)
    svc = _service(us=us)
    results = await asyncio.gather(svc.get("us"), svc.get("us"), svc.get("us"))
    assert us.calls == 1
    assert results[0] == results[1] == results[2]


async def test_service_unknown_market_is_a_value_error():
    svc = _service()
    with pytest.raises(ValueError):
        await svc.get("xyz")


async def test_service_crypto_market_is_served_from_its_own_fetcher():
    crypto = _Source(COINGECKO)
    svc = _service(crypto=crypto)
    answer = await svc.get("crypto")
    assert answer.market == "crypto"
    assert answer.source == CRYPTO_SOURCE
    assert answer.items[0].symbol == "BTC"
    assert crypto.calls == 1


async def test_service_does_not_retry_a_failed_refresh_within_15_seconds():
    us = _Source(NASDAQ)
    mono = _Mono()
    svc = _service(us=us, mono=mono)
    await svc.get("us")
    mono.t += 61.0
    us.fail = True
    await svc.get("us")  # the refresh fails here and is remembered
    assert us.calls == 2
    mono.t += 5.0
    stale = await svc.get("us")
    assert us.calls == 2
    assert stale.stale is True
    mono.t += 11.0  # 16 s after the failure
    await svc.get("us")
    assert us.calls == 3


async def test_service_does_not_retry_a_failed_first_fetch_within_15_seconds():
    us = _Source(NASDAQ)
    us.fail = True
    mono = _Mono()
    svc = _service(us=us, mono=mono)
    with pytest.raises(MarketMapUnavailable):
        await svc.get("us")
    mono.t += 5.0
    with pytest.raises(MarketMapUnavailable):
        await svc.get("us")
    assert us.calls == 1


async def test_service_close_is_safe_without_a_session():
    svc = _service()
    await svc.close()
