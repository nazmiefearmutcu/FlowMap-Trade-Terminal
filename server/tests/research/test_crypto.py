"""Crypto sections: parsers on trimmed real replies, caches on a fake clock. No network.

Fixtures are real replies trimmed to a few rows (``fixtures/crypto_*``). Routes in the
fake HTTP are keyed by URL path, plus ``symbol`` for the Binance per-pair endpoints.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, cast

import aiohttp
import pytest

from flowmap_server.research.base import Http, SectionResult, result
from flowmap_server.research.crypto import CryptoSource
from flowmap_server.research.options import OptionsSource

FIXTURES = Path(__file__).parent / "fixtures"

BINANCE = "https://fapi.binance.com"
EXCHANGE_INFO = f"{BINANCE}/fapi/v1/exchangeInfo"
PREMIUM_BTC = f"{BINANCE}/fapi/v1/premiumIndex?symbol=BTCUSDT"
PREMIUM_GTC = f"{BINANCE}/fapi/v1/premiumIndex?symbol=GTCUSDT"
PREMIUM_FOO = f"{BINANCE}/fapi/v1/premiumIndex?symbol=FOOUSDT"
OPEN_INTEREST = f"{BINANCE}/fapi/v1/openInterest"
LONG_SHORT = f"{BINANCE}/futures/data/globalLongShortAccountRatio"
TAKER = f"{BINANCE}/futures/data/takerlongshortRatio"
FUNDING_INFO = f"{BINANCE}/fapi/v1/fundingInfo"
COINGECKO = "https://api.coingecko.com/api/v3/coins/markets"
PROTOCOLS = "https://api.llama.fi/protocols"
CHAINS = "https://api.llama.fi/v2/chains"
FEAR_GREED = "https://api.alternative.me/fng/"

SECOND_NS = 1_000_000_000
HOUR_NS = 3600 * SECOND_NS
MINUTE_NS = 60 * SECOND_NS
MB = 1024 * 1024


def _fixture(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _key(url: str, params: Any) -> str:
    path = url.split("?", 1)[0]
    if params and "symbol" in params:
        return f"{path}?symbol={params['symbol']}"
    return path


class FakeHttp:
    """Serves canned bodies (or raises them) by route; records every call and its cap."""

    def __init__(self, routes: dict[str, object]) -> None:
        self.routes = dict(routes)
        self.calls: list[tuple[str, int]] = []

    def _serve(self, url: str, params: Any, limit: int) -> object:
        key = _key(url, params)
        self.calls.append((key, limit))
        if key not in self.routes:
            raise AssertionError(f"unexpected request {key}")
        answer = self.routes[key]
        if isinstance(answer, BaseException):
            raise answer
        return answer

    async def get_json(
        self,
        url: str,
        *,
        limit: int,
        headers: object = None,
        params: Any = None,
        timeout_s: float = 12.0,
    ) -> object:
        await asyncio.sleep(0)  # lets concurrent callers interleave, as a real read would
        return self._serve(url, params, limit)

    async def get_bytes(
        self,
        url: str,
        *,
        limit: int,
        headers: object = None,
        params: Any = None,
        timeout_s: float = 12.0,
    ) -> bytes:
        await asyncio.sleep(0)
        return json.dumps(self._serve(url, params, limit)).encode("utf-8")

    def count(self, key: str) -> int:
        return sum(1 for call, _ in self.calls if call == key)


class FakeOptions:
    def __init__(self) -> None:
        self.bases: list[str] = []

    async def crypto_gex(self, base: str) -> SectionResult:
        self.bases.append(base)
        return result("options", base, "ok", source="Deribit", fetched_ns=1, data={"gex": 1})


class Clock:
    def __init__(self) -> None:
        self.ns = 1_000_000_000_000

    def __call__(self) -> int:
        return self.ns

    def advance(self, ns: int) -> None:
        self.ns += ns


def _http_error(status: int) -> aiohttp.ClientResponseError:
    return aiohttp.ClientResponseError(cast(Any, None), (), status=status)


def _market_row(coin_id: str, symbol: str, cap: float | None) -> dict[str, Any]:
    """A synthetic CoinGecko row (only for the cases the real sample does not cover)."""
    return {
        "id": coin_id,
        "symbol": symbol,
        "name": coin_id.title(),
        "market_cap": cap,
        "market_cap_rank": 1,
        "current_price": 1.0,
        "price_change_percentage_24h_in_currency": 0.0,
        "price_change_percentage_7d_in_currency": 0.0,
        "price_change_percentage_30d_in_currency": 0.0,
        "total_volume": 1.0,
        "circulating_supply": 1.0,
        "total_supply": 1.0,
        "max_supply": None,
        "ath": 2.0,
        "ath_change_percentage": -50.0,
        "ath_date": "2025-01-01T00:00:00.000Z",
        "last_updated": "2026-11-14T00:00:00.000Z",
    }


def _binance_routes() -> dict[str, object]:
    return {
        EXCHANGE_INFO: _fixture("crypto_binance_exchange_info.json"),
        PREMIUM_BTC: _fixture("crypto_binance_premium_btc.json"),
        f"{OPEN_INTEREST}?symbol=BTCUSDT": _fixture("crypto_binance_open_interest_btc.json"),
        f"{LONG_SHORT}?symbol=BTCUSDT": _fixture("crypto_binance_long_short_btc.json"),
        f"{TAKER}?symbol=BTCUSDT": _fixture("crypto_binance_taker_btc.json"),
        FUNDING_INFO: _fixture("crypto_binance_fundinginfo.json"),
    }


def _market_routes(overrides: dict[str, object] | None = None) -> dict[str, object]:
    routes: dict[str, object] = {
        COINGECKO: _fixture("crypto_coingecko_markets.json"),
        PROTOCOLS: _fixture("crypto_defillama_protocols.json"),
        CHAINS: _fixture("crypto_defillama_chains.json"),
    }
    routes.update(overrides or {})
    return routes


def _source(
    routes: dict[str, object], clock: Clock | None = None
) -> tuple[CryptoSource, FakeHttp, FakeOptions]:
    http = FakeHttp(routes)
    options = FakeOptions()
    source = CryptoSource(cast(Http, http), cast(OptionsSource, options), clock=clock or Clock())
    return source, http, options


# --- derivatives -------------------------------------------------------------


async def test_btc_perpetual_from_real_replies() -> None:
    source, _, _ = _source(_binance_routes())
    answer = await source.derivatives("BTC")
    assert answer.status == "ok"
    assert answer.source == "Binance Futures"
    assert answer.as_of == "2026-11-14"
    assert answer.data is not None
    data = answer.data
    assert set(data) == {
        "pair", "markPrice", "indexPrice", "fundingRate", "fundingIntervalHours",
        "fundingRateAnnualPct", "nextFundingTime", "openInterest", "openInterestUsd",
        "longShortAccountRatio", "longAccountPct", "shortAccountPct", "takerBuySellRatio",
    }
    assert data["pair"] == "BTCUSDT"
    assert data["markPrice"] == pytest.approx(63427.2)
    assert data["indexPrice"] == pytest.approx(63457.75586957)
    assert data["fundingRate"] == pytest.approx(0.00002826)
    assert data["fundingIntervalHours"] == 8
    assert data["fundingRateAnnualPct"] == pytest.approx(3.09447)
    assert data["nextFundingTime"] == 1794700800000
    assert data["openInterest"] == pytest.approx(98025.323)
    assert data["openInterestUsd"] == pytest.approx(98025.323 * 63427.2)
    assert data["longShortAccountRatio"] == pytest.approx(2.8476)
    assert data["longAccountPct"] == pytest.approx(74.01)
    assert data["shortAccountPct"] == pytest.approx(25.99)
    assert data["takerBuySellRatio"] == pytest.approx(0.9155)


async def test_four_hour_funding_is_annualized_on_its_own_interval() -> None:
    routes = {
        EXCHANGE_INFO: _fixture("crypto_binance_exchange_info.json"),
        PREMIUM_GTC: _fixture("crypto_binance_premium_gtc.json"),
        f"{OPEN_INTEREST}?symbol=GTCUSDT": _fixture("crypto_binance_open_interest_gtc.json"),
        f"{LONG_SHORT}?symbol=GTCUSDT": _fixture("crypto_binance_taker_empty.json"),
        f"{TAKER}?symbol=GTCUSDT": _fixture("crypto_binance_taker_empty.json"),
        FUNDING_INFO: _fixture("crypto_binance_fundinginfo.json"),
    }
    source, _, _ = _source(routes)
    data = (await source.derivatives("GTC")).data
    assert data is not None
    assert data["fundingIntervalHours"] == 4
    assert data["fundingRate"] == pytest.approx(-0.00013602)
    # rate * 24 / interval * 365 * 100: six settlements a day on a 4 h interval.
    assert data["fundingRateAnnualPct"] == pytest.approx(-0.00013602 * 6 * 365 * 100)


async def test_pair_not_in_perpetual_trading_set_is_not_applicable_without_premium_call() -> None:
    source, http, _ = _source(_binance_routes())
    answer = await source.derivatives("FOO")
    assert answer.status == "not_applicable"
    assert answer.reason == "no_perpetual"
    assert answer.data is None
    assert [call for call, _ in http.calls] == [EXCHANGE_INFO]


@pytest.mark.parametrize("base", ["OMG", "GAIB", "XAU"])
async def test_listed_but_not_a_trading_perpetual_is_not_applicable(base: str) -> None:
    # OMG is SETTLING, GAIB is PENDING_TRADING, XAU is TRADIFI_PERPETUAL (not PERPETUAL).
    source, http, _ = _source(_binance_routes())
    answer = await source.derivatives(base)
    assert answer.status == "not_applicable"
    assert answer.reason == "no_perpetual"
    assert all(not call.startswith(f"{BINANCE}/fapi/v1/premiumIndex") for call, _ in http.calls)


async def test_http_error_from_premium_index_is_a_source_fault() -> None:
    routes = _binance_routes()
    routes[PREMIUM_BTC] = _http_error(400)
    source, _, _ = _source(routes)
    with pytest.raises(aiohttp.ClientResponseError):
        await source.derivatives("BTC")


async def test_non_numeric_mark_price_is_malformed() -> None:
    routes = _binance_routes()
    premium = dict(_fixture("crypto_binance_premium_btc.json"), markPrice="nan")
    routes[PREMIUM_BTC] = premium
    source, _, _ = _source(routes)
    with pytest.raises(ValueError):
        await source.derivatives("BTC")


async def test_empty_ratio_replies_give_none_not_failure() -> None:
    routes = _binance_routes()
    routes[f"{LONG_SHORT}?symbol=BTCUSDT"] = []
    routes[f"{TAKER}?symbol=BTCUSDT"] = _fixture("crypto_binance_taker_empty.json")
    source, _, _ = _source(routes)
    answer = await source.derivatives("BTC")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["longShortAccountRatio"] is None
    assert answer.data["longAccountPct"] is None
    assert answer.data["shortAccountPct"] is None
    assert answer.data["takerBuySellRatio"] is None
    assert answer.data["openInterest"] == pytest.approx(98025.323)


async def test_unlisted_funding_interval_defaults_to_eight_hours() -> None:
    funding = [row for row in _fixture("crypto_binance_fundinginfo.json") if row["symbol"] != "BTCUSDT"]
    routes = _binance_routes()
    routes[FUNDING_INFO] = funding
    source, _, _ = _source(routes)
    data = (await source.derivatives("BTC")).data
    assert data is not None
    assert data["fundingIntervalHours"] == 8


@pytest.mark.parametrize(
    "row",
    [
        {"symbol": "BTCUSDT"},
        {"symbol": "BTCUSDT", "fundingIntervalHours": True},
        {"symbol": "BTCUSDT", "fundingIntervalHours": 0},
        {"symbol": 7, "fundingIntervalHours": 8},
    ],
)
async def test_malformed_funding_row_raises(row: dict[str, Any]) -> None:
    routes = _binance_routes()
    routes[FUNDING_INFO] = [row]
    source, _, _ = _source(routes)
    with pytest.raises(ValueError):
        await source.derivatives("BTC")


async def test_funding_list_is_kept_six_hours_on_the_clock() -> None:
    clock = Clock()
    source, http, _ = _source(_binance_routes(), clock)
    await source.derivatives("BTC")
    await source.derivatives("BTC")
    assert http.count(FUNDING_INFO) == 1
    clock.advance(6 * HOUR_NS)
    await source.derivatives("BTC")
    assert http.count(FUNDING_INFO) == 2


async def test_perpetual_set_is_kept_six_hours_on_the_clock() -> None:
    clock = Clock()
    source, http, _ = _source(_binance_routes(), clock)
    await source.derivatives("BTC")
    await source.derivatives("FOO")  # not listed: answered from the same set, no premium call
    assert http.count(EXCHANGE_INFO) == 1
    clock.advance(6 * HOUR_NS)
    await source.derivatives("BTC")
    assert http.count(EXCHANGE_INFO) == 2


async def test_failed_funding_refresh_is_not_repeated_for_sixty_seconds() -> None:
    clock = Clock()
    routes = _binance_routes()
    routes[FUNDING_INFO] = aiohttp.ClientConnectionError("down")
    source, http, _ = _source(routes, clock)
    with pytest.raises(aiohttp.ClientConnectionError):
        await source.derivatives("BTC")
    with pytest.raises(aiohttp.ClientConnectionError):
        await source.derivatives("BTC")
    assert http.count(FUNDING_INFO) == 1
    clock.advance(60 * SECOND_NS)
    http.routes[FUNDING_INFO] = _fixture("crypto_binance_fundinginfo.json")
    answer = await source.derivatives("BTC")
    assert answer.status == "ok"
    assert http.count(FUNDING_INFO) == 2


async def test_funding_failure_serves_the_previous_list_during_the_floor() -> None:
    clock = Clock()
    routes = _binance_routes()
    source, http, _ = _source(routes, clock)
    await source.derivatives("BTC")
    clock.advance(6 * HOUR_NS)
    http.routes[FUNDING_INFO] = aiohttp.ClientConnectionError("down")
    first = await source.derivatives("BTC")
    second = await source.derivatives("BTC")
    assert first.status == "ok" and second.status == "ok"
    assert http.count(FUNDING_INFO) == 2  # the refresh after expiry, then none during the floor


async def test_concurrent_cold_callers_share_one_list_load() -> None:
    source, http, _ = _source(_binance_routes())
    answers = await asyncio.gather(source.derivatives("BTC"), source.derivatives("BTC"))
    assert [a.status for a in answers] == ["ok", "ok"]
    assert http.count(FUNDING_INFO) == 1
    assert http.count(EXCHANGE_INFO) == 1


async def test_binance_caps() -> None:
    source, http, _ = _source(_binance_routes())
    await source.derivatives("BTC")
    limits = {call: limit for call, limit in http.calls}
    assert limits[EXCHANGE_INFO] == 8 * MB
    assert limits[PREMIUM_BTC] == MB
    assert limits[f"{OPEN_INTEREST}?symbol=BTCUSDT"] == MB
    assert limits[f"{LONG_SHORT}?symbol=BTCUSDT"] == MB
    assert limits[f"{TAKER}?symbol=BTCUSDT"] == MB
    assert limits[FUNDING_INFO] == 2 * MB


# --- options -----------------------------------------------------------------


async def test_options_delegates_to_the_options_module() -> None:
    source, _, options = _source({})
    answer = await source.options("ETH")
    assert options.bases == ["ETH"]
    assert answer.section == "options"
    assert answer.data == {"gex": 1}


# --- market ------------------------------------------------------------------


async def test_ethereum_market_falls_through_null_protocol_to_chain_tvl() -> None:
    source, _, _ = _source(_market_routes())
    answer = await source.market("ETH")
    assert answer.status == "ok"
    assert answer.source == "CoinGecko and DefiLlama"
    assert answer.as_of == "2026-11-14"
    assert answer.data is not None
    data = answer.data
    assert set(data) == {
        "coinId", "name", "rank", "price", "change24hPct", "change7dPct", "change30dPct",
        "marketCap", "volume24h", "circulatingSupply", "totalSupply", "maxSupply", "ath",
        "athChangePct", "athDate", "tvl", "tvlSource", "tvlReason",
    }
    assert data["coinId"] == "ethereum"
    assert data["name"] == "Ethereum"
    assert data["rank"] == 2
    assert data["price"] == pytest.approx(1742.9)
    assert data["change24hPct"] == pytest.approx(-9.48589)
    assert data["change7dPct"] == pytest.approx(-20.4499)
    assert data["change30dPct"] == pytest.approx(-27.7429)
    assert data["marketCap"] == 213190033202
    assert data["maxSupply"] is None
    assert data["ath"] == pytest.approx(4946.05)
    assert data["athChangePct"] == pytest.approx(-64.76179)
    assert data["athDate"] == "2025-08-24"
    assert data["tvl"] == pytest.approx(37574903690.3125)
    assert data["tvlSource"] == "chain"
    assert data["tvlReason"] is None


async def test_bitcoin_has_chain_tvl_and_protocol_with_none_is_skipped() -> None:
    source, _, _ = _source(_market_routes())
    data = (await source.market("BTC")).data
    assert data is not None
    assert data["coinId"] == "bitcoin"
    assert data["tvl"] == pytest.approx(3411632606.183582)
    assert data["tvlSource"] == "chain"


async def test_protocol_tvl_comes_before_chain_tvl() -> None:
    source, _, _ = _source(_market_routes())
    data = (await source.market("LDO")).data
    assert data is not None
    assert data["coinId"] == "lido-dao"
    assert data["tvl"] == pytest.approx(17873164908.59406)
    assert data["tvlSource"] == "protocol"


async def test_coin_with_no_tvl_gives_none_and_no_reason() -> None:
    rows = [_market_row("no-tvl-coin", "ntc", 5.0)]
    source, _, _ = _source(_market_routes({COINGECKO: rows}))
    data = (await source.market("NTC")).data
    assert data is not None
    assert data["tvl"] is None
    assert data["tvlSource"] is None
    assert data["tvlReason"] is None


async def test_protocols_failure_leaves_tvl_none_with_reason() -> None:
    source, _, _ = _source(_market_routes({PROTOCOLS: aiohttp.ClientConnectionError("down")}))
    answer = await source.market("ETH")
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["price"] == pytest.approx(1742.9)
    assert answer.data["tvl"] is None
    assert answer.data["tvlSource"] is None
    assert answer.data["tvlReason"] == "unreachable"


async def test_chains_failure_after_a_null_protocol_leaves_tvl_none_with_reason() -> None:
    # ETH's only protocol match has a null TVL, so the chain list is needed and it fails.
    source, _, _ = _source(_market_routes({CHAINS: aiohttp.ClientConnectionError("down")}))
    data = (await source.market("ETH")).data
    assert data is not None
    assert data["tvl"] is None
    assert data["tvlSource"] is None
    assert data["tvlReason"] == "unreachable"


async def test_symbol_clash_picks_largest_market_cap_and_its_tvl() -> None:
    # "eth" twice: the chain ethereum (cap 9) wins over the synthetic small one (cap 1).
    rows = [_market_row("small-eth", "eth", 1.0), _market_row("ethereum", "eth", 9.0)]
    source, _, _ = _source(_market_routes({COINGECKO: rows}))
    data = (await source.market("ETH")).data
    assert data is not None
    assert data["coinId"] == "ethereum"
    assert data["tvl"] == pytest.approx(37574903690.3125)
    assert data["tvlSource"] == "chain"


async def test_coin_outside_top_250_is_not_applicable() -> None:
    source, http, _ = _source(_market_routes())
    answer = await source.market("ZZZ")
    assert answer.status == "not_applicable"
    assert answer.reason == "not_in_top_250"
    assert answer.data is None
    assert http.count(PROTOCOLS) == 0


async def test_market_list_is_kept_six_hours_and_kept_on_failed_refresh() -> None:
    clock = Clock()
    source, http, _ = _source(_market_routes(), clock)
    await source.market("ETH")
    await source.market("BTC")
    assert http.count(COINGECKO) == 1
    clock.advance(6 * HOUR_NS)
    http.routes[COINGECKO] = aiohttp.ClientConnectionError("down")
    answer = await source.market("ETH")
    assert http.count(COINGECKO) == 2
    assert answer.status == "ok"
    assert answer.data is not None
    assert answer.data["coinId"] == "ethereum"


async def test_failed_market_refresh_is_not_repeated_for_sixty_seconds() -> None:
    clock = Clock()
    source, http, _ = _source(_market_routes({COINGECKO: aiohttp.ClientConnectionError("down")}), clock)
    with pytest.raises(aiohttp.ClientConnectionError):
        await source.market("ETH")
    with pytest.raises(aiohttp.ClientConnectionError):
        await source.market("BTC")
    assert http.count(COINGECKO) == 1
    clock.advance(60 * SECOND_NS)
    http.routes[COINGECKO] = _fixture("crypto_coingecko_markets.json")
    assert (await source.market("ETH")).status == "ok"
    assert http.count(COINGECKO) == 2


async def test_protocols_list_is_kept_six_hours_and_kept_on_failed_refresh() -> None:
    clock = Clock()
    source, http, _ = _source(_market_routes(), clock)
    await source.market("BTC")
    await source.market("LDO")
    assert http.count(PROTOCOLS) == 1
    clock.advance(6 * HOUR_NS)
    http.routes[PROTOCOLS] = aiohttp.ClientConnectionError("down")
    answer = await source.market("LDO")
    assert answer.data is not None
    assert answer.data["tvlSource"] == "protocol"  # the previous list is served
    await source.market("LDO")
    assert http.count(PROTOCOLS) == 2  # one failed refresh, none during the 60 s floor


async def test_chains_list_is_kept_six_hours() -> None:
    clock = Clock()
    source, http, _ = _source(_market_routes(), clock)
    await source.market("BTC")
    await source.market("BTC")
    assert http.count(CHAINS) == 1
    clock.advance(6 * HOUR_NS)
    await source.market("BTC")
    assert http.count(CHAINS) == 2


async def test_concurrent_cold_market_callers_share_one_coingecko_load() -> None:
    source, http, _ = _source(_market_routes())
    answers = await asyncio.gather(source.market("ETH"), source.market("BTC"))
    assert [a.status for a in answers] == ["ok", "ok"]
    assert http.count(COINGECKO) == 1
    assert http.count(PROTOCOLS) == 1
    assert http.count(CHAINS) == 1


async def test_market_caps() -> None:
    source, http, _ = _source(_market_routes())
    await source.market("ETH")
    limits = {call: limit for call, limit in http.calls}
    assert limits[COINGECKO] == 4 * MB
    assert limits[PROTOCOLS] == 24 * MB
    assert limits[CHAINS] == 2 * MB


# --- sentiment ---------------------------------------------------------------


async def test_fear_and_greed_from_real_replies() -> None:
    source, http, _ = _source({FEAR_GREED: _fixture("crypto_alternative_fng.json")})
    answer = await source.sentiment()
    assert answer.status == "ok"
    assert answer.symbol == "MARKET"
    assert answer.source == "alternative.me"
    assert answer.as_of == "2026-11-14"
    assert answer.data is not None
    data = answer.data
    assert set(data) == {"value", "label", "history", "avg7d", "avg30d"}
    assert data["value"] == 13
    assert data["label"] == "Extreme Fear"
    assert len(data["history"]) == 30
    assert data["history"][0] == {"date": "2026-11-14", "value": 13}
    assert data["history"][-1] == {"date": "2026-10-16", "value": 63}
    # Seven days back from the newest point, and all thirty.
    assert data["avg7d"] == pytest.approx(25.571428571428573)
    assert data["avg30d"] == pytest.approx(41.46666666666667)
    assert http.calls[0][1] == 256 * 1024


async def test_sentiment_sorts_unsorted_points_newest_first() -> None:
    body = {
        "data": [
            {"value": "20", "value_classification": "Fear", "timestamp": "1794600000"},
            {"value": "40", "value_classification": "Fear", "timestamp": "1794614400"},
        ]
    }
    source, _, _ = _source({FEAR_GREED: body})
    data = (await source.sentiment()).data
    assert data is not None
    assert data["value"] == 40
    assert data["label"] == "Fear"
    assert [point["date"] for point in data["history"]] == ["2026-11-14", "2026-11-13"]
    assert data["avg7d"] == pytest.approx(30.0)


async def test_seven_day_average_excludes_a_point_exactly_seven_days_old() -> None:
    newest = 1794614400  # 2026-11-14 00:00 UTC
    day = 86400
    body = {
        "data": [
            {"value": "10", "value_classification": "Fear", "timestamp": str(newest)},
            {"value": "20", "value_classification": "Fear", "timestamp": str(newest - 6 * day)},
            {"value": "1000", "value_classification": "Fear", "timestamp": str(newest - 7 * day)},
        ]
    }
    source, _, _ = _source({FEAR_GREED: body})
    data = (await source.sentiment()).data
    assert data is not None
    assert data["avg7d"] == pytest.approx(15.0)
    assert data["avg30d"] == pytest.approx((10 + 20 + 1000) / 3)


async def test_sentiment_average_needs_two_points() -> None:
    body = {"data": [{"value": "40", "value_classification": "Fear", "timestamp": "1794614400"}]}
    source, _, _ = _source({FEAR_GREED: body})
    data = (await source.sentiment()).data
    assert data is not None
    assert data["avg7d"] is None
    assert data["avg30d"] is None
    assert data["history"] == [{"date": "2026-11-14", "value": 40}]


async def test_sentiment_without_points_is_empty() -> None:
    source, _, _ = _source({FEAR_GREED: {"data": []}})
    answer = await source.sentiment()
    assert answer.status == "empty"
    assert answer.data is None
