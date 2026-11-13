"""Market map parsing and the cached service, with no network.

The parsers run on the trimmed real payloads under ``tests/api/fixtures`` and on
small inline rows where an exact value is asserted. The service runs against
fake fetchers and an injected monotonic clock.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import aiohttp
import pytest

from flowmap_server.data.market_map import (
    CRYPTO_LIMIT,
    CRYPTO_SOURCE,
    PAIRS_RETRY_S,
    PAIRS_TTL_S,
    US_SOURCE,
    MarketMapService,
    MarketMapUnavailable,
    parse_crypto,
    parse_us,
    parse_usdt_pairs,
    read_capped_json,
)
from flowmap_server.data.universe import CRYPTO_MARKET, CRYPTO_SYMBOLS

FIXTURES = Path(__file__).resolve().parents[1] / "api" / "fixtures" / "market_map"
NASDAQ = json.loads((FIXTURES / "nasdaq_screener.json").read_text(encoding="utf-8"))
COINGECKO = json.loads((FIXTURES / "coingecko_markets.json").read_text(encoding="utf-8"))
NOW_NS = 1_700_000_000_123_456_789
# A slice of Binance's ticker list: USDT pairs, plus a BUSD pair that must be ignored.
PAIRS_PAYLOAD = [
    {"symbol": "BTCUSDT", "price": "68000.00"},
    {"symbol": "ZECUSDT", "price": "40.00"},
    {"symbol": "XMRUSDT", "price": "160.00"},
    {"symbol": "ETHBUSD", "price": "3500.00"},
]


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
             mono: _Mono | None = None, pairs: _Source | None = None) -> MarketMapService:
    return MarketMapService(
        fetch_us=us or _Source(NASDAQ),
        fetch_crypto=crypto or _Source(COINGECKO),
        fetch_pairs=pairs or _Source(PAIRS_PAYLOAD),
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


# --- review round 1: names, overflow, body cap, log hygiene --------------------


def test_us_name_cut_needs_a_whole_word():
    rows = [
        _row(symbol="HC", name="Hall Class Assets Inc", market_cap="2"),
        _row(symbol="GOOG", name="Alphabet Inc. Class A Common Stock", market_cap="1"),
    ]
    got = {i.symbol: i.name for i in parse_us(_us(*rows))}
    assert got == {"HC": "Hall Class Assets Inc", "GOOG": "Alphabet Inc."}


def test_us_overflowing_number_skips_only_its_own_row_or_value():
    huge = 10**400  # a JSON integer too large for a float
    rows = [
        {**_row(symbol="HUGECAP"), "marketCap": huge},
        {**_row(symbol="HUGEPRICE"), "lastsale": huge},
        {**_row(symbol="BIGVOL"), "volume": huge},
        _row(symbol="GOOD"),
    ]
    items = {i.symbol: i for i in parse_us(_us(*rows))}
    assert set(items) == {"BIGVOL", "GOOD"}
    assert items["BIGVOL"].volume is None


def test_crypto_overflowing_cap_skips_only_that_coin():
    items = parse_crypto([_coin(symbol="big", cap=10**400), _coin()])
    assert [i.symbol for i in items] == ["BTC"]


class _FakeStream:
    """Hands out at most ``piece`` bytes per read, like a real socket stream."""

    def __init__(self, data: bytes, piece: int) -> None:
        self._data = data
        self._piece = piece
        self.reads = 0

    async def read(self, n: int = -1) -> bytes:
        self.reads += 1
        size = min(n, self._piece)
        chunk, self._data = self._data[:size], self._data[size:]
        return chunk


class _FakeBody:
    def __init__(self, data: bytes, *, declared: int | None = None, piece: int = 3) -> None:
        self.content_length = declared
        self.content = _FakeStream(data, piece)


async def test_capped_read_decodes_a_body_under_the_cap():
    body = _FakeBody(b'{"a": [1, 2, 3]}', declared=15)
    assert await read_capped_json(body, limit=64) == {"a": [1, 2, 3]}


async def test_capped_read_accepts_a_body_exactly_at_the_cap():
    data = b"[1,2,3,4,5]"
    assert await read_capped_json(_FakeBody(data), limit=len(data)) == [1, 2, 3, 4, 5]


async def test_capped_read_refuses_a_declared_length_over_the_cap_without_reading():
    body = _FakeBody(b"[1,2,3]", declared=500)
    with pytest.raises(ValueError):
        await read_capped_json(body, limit=10)
    assert body.content.reads == 0


async def test_capped_read_refuses_an_undeclared_body_over_the_cap():
    body = _FakeBody(b"[" + b"1," * 50 + b"1]", declared=None)
    with pytest.raises(ValueError):
        await read_capped_json(body, limit=20)


class _UpstreamError(aiohttp.ClientResponseError):
    """Stands in for an aiohttp HTTP error, whose text carries the full URL."""

    def __str__(self) -> str:
        return "503, message='Service Unavailable', url='https://feed.test/list?key=abc123'"


async def test_failed_refresh_logs_the_status_and_never_the_url(caplog):
    async def fetch_us() -> object:
        raise _UpstreamError(None, (), status=503, message="Service Unavailable")

    svc = MarketMapService(
        fetch_us=fetch_us, fetch_crypto=_Source(COINGECKO), clock=lambda: NOW_NS
    )
    with caplog.at_level(logging.WARNING, logger="flowmap_server.data.market_map"):
        with pytest.raises(MarketMapUnavailable) as info:
            await svc.get("us")
    assert "HTTP 503" in caplog.text
    for text in (caplog.text, str(info.value)):
        assert "?" not in text
        assert "http" not in text


# --- round 2: learned USDT pairs ------------------------------------------------


def test_usdt_pairs_keeps_only_the_usdt_symbols():
    payload = [
        {"symbol": "ZECUSDT", "price": "1"},
        {"symbol": "ETHBUSD", "price": "2"},
        {"symbol": "ETHUSDT", "price": "3"},
    ]
    assert parse_usdt_pairs(payload) == frozenset({"ZECUSDT", "ETHUSDT"})


@pytest.mark.parametrize(
    "payload",
    [None, {}, "BTCUSDT", ["BTCUSDT"], [{"symbol": 5}], [{"price": "1"}],
     [{"symbol": "ETHBUSD"}]],
)
def test_usdt_pairs_bad_payload_raises_value_error(payload):
    with pytest.raises(ValueError):
        parse_usdt_pairs(payload)


async def test_coin_outside_the_bundled_shortlist_charts_from_the_learned_pairs():
    assert "ZECUSDT" not in CRYPTO_SYMBOLS  # the case under test
    svc = _service(crypto=_Source([_coin(symbol="zec", name="Zcash", cap=1e9),
                                   _coin(symbol="foo", name="Foo", cap=1e8)]))
    charts = {i.symbol: i.chart for i in (await svc.get("crypto")).items}
    assert charts["ZEC"] == {"market": CRYPTO_MARKET, "symbol": "ZECUSDT"}
    assert charts["FOO"] is None


async def test_pairs_are_fetched_once_across_two_crypto_refreshes_inside_six_hours():
    pairs = _Source(PAIRS_PAYLOAD)
    crypto = _Source(COINGECKO)
    mono = _Mono()
    svc = _service(crypto=crypto, pairs=pairs, mono=mono)
    await svc.get("crypto")
    mono.t += 61.0  # the coin map expires; the pair list does not
    await svc.get("crypto")
    assert crypto.calls == 2
    assert pairs.calls == 1
    mono.t += PAIRS_TTL_S  # now past six hours since the pair list was fetched
    await svc.get("crypto")
    assert pairs.calls == 2


async def test_failing_pairs_fetch_falls_back_to_the_bundled_list_and_still_answers():
    pairs = _Source(None)
    pairs.fail = True
    svc = _service(crypto=_Source(COINGECKO), pairs=pairs)
    answer = await svc.get("crypto")
    assert answer.stale is False
    assert answer.items[0].symbol == "BTC"
    assert answer.items[0].chart == {"market": CRYPTO_MARKET, "symbol": "BTCUSDT"}
    assert pairs.calls == 1


async def test_failed_pairs_refresh_keeps_the_previous_set():
    pairs = _Source(PAIRS_PAYLOAD)
    mono = _Mono()
    svc = _service(crypto=_Source([_coin(symbol="zec", name="Zcash", cap=1e9)]),
                   pairs=pairs, mono=mono)
    await svc.get("crypto")
    mono.t += PAIRS_TTL_S + 1.0
    pairs.fail = True
    answer = await svc.get("crypto")
    assert pairs.calls == 2
    assert answer.items[0].chart == {"market": CRYPTO_MARKET, "symbol": "ZECUSDT"}


async def test_failed_pairs_refresh_is_not_retried_within_five_minutes():
    pairs = _Source(None)
    pairs.fail = True
    mono = _Mono()
    crypto = _Source(COINGECKO)
    svc = _service(crypto=crypto, pairs=pairs, mono=mono)
    await svc.get("crypto")  # the pair refresh fails at t=1000
    assert pairs.calls == 1
    mono.t += 61.0  # the coin map expires; still inside the five-minute floor
    await svc.get("crypto")
    assert pairs.calls == 1
    assert crypto.calls == 2
    mono.t += 240.0  # 301 s after the failure
    await svc.get("crypto")
    assert pairs.calls == 2
    assert PAIRS_RETRY_S == 300.0


@pytest.mark.parametrize("payload", [{"not": "a list"}, "text", [{"symbol": 5}]])
async def test_malformed_pairs_payload_is_a_failure_not_a_crash(payload):
    pairs = _Source(payload)
    svc = _service(crypto=_Source(COINGECKO), pairs=pairs)
    answer = await svc.get("crypto")
    assert answer.items[0].chart == {"market": CRYPTO_MARKET, "symbol": "BTCUSDT"}
    assert pairs.calls == 1


# --- round 2: more stablecoins and the dollar-price rule -------------------------


@pytest.mark.parametrize("symbol", ["USDY", "USYC", "EURS", "GHO", "WBNB", "TBTC"])
def test_listed_stable_and_wrapped_coins_are_excluded(symbol):
    rows = [_coin(symbol=symbol.lower(), name="Listed"), _coin()]
    assert [i.symbol for i in parse_crypto(rows)] == ["BTC"]


def test_gold_tokens_are_kept():
    rows = [_coin(symbol="PAXG", name="PAX Gold", price=2600.0),
            _coin(symbol="XAUT", name="Tether Gold", price=2600.0, cap=5e9)]
    assert {i.symbol for i in parse_crypto(rows)} == {"PAXG", "XAUT"}


def test_unlisted_usd_named_coin_at_one_dollar_is_skipped():
    rows = [_coin(symbol="fusd2", name="Foo USD", price=1.001, cap=1e9), _coin()]
    assert [i.symbol for i in parse_crypto(rows)] == ["BTC"]


def test_coin_at_one_dollar_without_usd_in_its_name_is_kept():
    rows = [_coin(symbol="mup", name="Made Up", price=1.00, cap=1e9)]
    assert [i.symbol for i in parse_crypto(rows)] == ["MUP"]


def test_usd_named_coins_far_from_one_dollar_are_kept():
    rows = [
        _coin(symbol="uxc", name="USD Coin", price=2.5, cap=2e9),
        _coin(symbol="uxd", name="USD Coin", price=0.5, cap=1e9),
    ]
    assert {i.symbol for i in parse_crypto(rows)} == {"UXC", "UXD"}


def test_usd_inside_a_longer_word_does_not_trigger_the_rule():
    rows = [_coin(symbol="ulk", name="USDLike Token", price=1.00, cap=1e9)]
    assert [i.symbol for i in parse_crypto(rows)] == ["ULK"]
