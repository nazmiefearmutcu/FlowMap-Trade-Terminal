"""The research service's routing, the SEC contact rule, names and the REST route. No network."""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
import pytest

from flowmap_server.api.app import create_app
from flowmap_server.config import Config
from flowmap_server.research.base import Http, SectionResult, result
from flowmap_server.research.names import CompanyNames, legal_core, parse_listing
from flowmap_server.research.service import (
    SEC_CONTACT_ENV,
    SECTIONS,
    ResearchService,
    UnknownSection,
    sec_contact,
)


class _Recorder:
    """Stands in for every source; records the calls and answers ok."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    def _ok(self, section: str, symbol: str) -> SectionResult:
        return result(section, symbol, "ok", source="Test", fetched_ns=1, data={"from": "fake"})

    async def risk_factors(self, symbol: str, contact: str) -> SectionResult:
        self.calls.append(("risk-factors", symbol, contact))
        return self._ok("risk-factors", symbol)

    async def management_language(self, symbol: str, contact: str) -> SectionResult:
        self.calls.append(("language", symbol, contact))
        return self._ok("language", symbol)

    async def contracts(self, symbol: str) -> SectionResult:
        self.calls.append(("contracts", symbol))
        return self._ok("contracts", symbol)

    async def trades(self, symbol: str) -> SectionResult:
        self.calls.append(("house-trades", symbol))
        return self._ok("house-trades", symbol)

    async def equity_gex(self, symbol: str) -> SectionResult:
        self.calls.append(("gex", symbol))
        return self._ok("gex", symbol)

    async def short_volume(self, symbol: str) -> SectionResult:
        self.calls.append(("short-volume", symbol))
        return self._ok("short-volume", symbol)

    async def hiring(self, symbol: str) -> SectionResult:
        self.calls.append(("hiring", symbol))
        return self._ok("hiring", symbol)

    async def derivatives(self, base: str) -> SectionResult:
        self.calls.append(("derivatives", base))
        return self._ok("derivatives", base)

    async def options(self, base: str) -> SectionResult:
        self.calls.append(("options", base))
        return self._ok("options", base)

    async def market(self, base: str) -> SectionResult:
        self.calls.append(("market", base))
        return self._ok("market", base)

    async def sentiment(self) -> SectionResult:
        self.calls.append(("sentiment",))
        return self._ok("sentiment", "MARKET")

    async def start(self) -> None:
        return None

    async def close(self) -> None:
        return None


def _service(fake: _Recorder) -> ResearchService:
    return ResearchService(
        http=Http(), sec=fake, contracts=fake, house=fake, options=fake,  # type: ignore[arg-type]
        short_volume=fake, hiring=fake, crypto=fake,  # type: ignore[arg-type]
    )


async def test_every_section_reaches_its_source_with_the_normalized_symbol() -> None:
    fake = _Recorder()
    service = _service(fake)
    for (market, section) in SECTIONS:
        raw = "nvda" if market == "us" else "binance:ETHUSDT"
        answer = await service.get(market, section, raw, contact="me@example.com")
        assert answer.status == "ok"
    assert ("gex", "NVDA") in fake.calls
    assert ("derivatives", "ETH") in fake.calls
    assert ("risk-factors", "NVDA", "me@example.com") in fake.calls
    assert ("sentiment",) in fake.calls
    await service.close()


async def test_the_sec_sections_need_a_contact() -> None:
    fake = _Recorder()
    service = _service(fake)
    answer = await service.get("us", "language", "NVDA", contact=None)
    assert (answer.status, answer.reason) == ("unavailable", "sec_contact_missing")
    assert fake.calls == []
    await service.close()


async def test_unknown_markets_sections_and_symbols_are_refused() -> None:
    service = _service(_Recorder())
    for market, section, symbol in (("fx", "gex", "EURUSD"), ("us", "jets", "NVDA"), ("us", "gex", "NV DA!")):
        with pytest.raises(UnknownSection):
            await service.get(market, section, symbol)
    await service.close()


def test_the_contact_comes_from_the_request_then_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SEC_CONTACT_ENV, raising=False)
    assert sec_contact(None) is None
    assert sec_contact("not an email") is None
    assert sec_contact(" me@example.com ") == "me@example.com"
    monkeypatch.setenv(SEC_CONTACT_ENV, "ops@example.org")
    assert sec_contact(None) == "ops@example.org"
    assert sec_contact("me@example.com") == "me@example.com"
    assert sec_contact("bad<>@x") == "ops@example.org"


def test_the_listing_gives_cleaned_names_by_ticker() -> None:
    payload = {"data": {"rows": [
        {"symbol": "AAPL", "name": "Apple Inc. Common Stock"},
        {"symbol": "BRK/B", "name": "Berkshire Hathaway Inc. Class B"},
        {"symbol": "", "name": "No ticker"},
        "junk",
    ]}}
    assert parse_listing(payload) == {"AAPL": "Apple Inc.", "BRK.B": "Berkshire Hathaway Inc."}
    with pytest.raises(ValueError):
        parse_listing({"data": {"rows": []}})


def test_the_legal_core_drops_legal_words_and_punctuation() -> None:
    assert legal_core("Lockheed Martin Corporation") == "lockheed martin"
    assert legal_core("The Boeing Company") == "boeing"
    assert legal_core("AT&T Inc.") == "at and t"


async def test_a_failed_listing_refresh_keeps_the_previous_names() -> None:
    mono = [0.0]
    payloads: list[object] = [{"data": {"rows": [{"symbol": "LMT", "name": "Lockheed Martin Corporation Common Stock"}]}}]

    async def fetch() -> object:
        item = payloads[0]
        if isinstance(item, Exception):
            raise item
        return item

    names = CompanyNames(Http(), fetch=fetch, monotonic=lambda: mono[0])
    assert await names.name("lmt") == "Lockheed Martin Corporation"
    payloads[0] = ConnectionError("down")
    mono[0] += 2 * 24 * 3600
    assert await names.name("LMT") == "Lockheed Martin Corporation"
    assert await names.name("ZZZZ") is None


def test_the_route_answers_camel_case_and_refuses_unknown_sections(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(SEC_CONTACT_ENV, raising=False)
    fake = _Recorder()
    app = create_app(Config())
    app.state.research = _service(fake)
    with TestClient(app) as client:
        ok = client.get("/api/research/us/gex", params={"symbol": "nvda"})
        assert ok.status_code == 200
        body = ok.json()
        assert body["section"] == "gex" and body["symbol"] == "NVDA" and body["status"] == "ok"
        assert set(body) == {"section", "symbol", "status", "reason", "source", "asOf", "fetchedAt", "stale", "data"}
        assert client.get("/api/research/us/jets", params={"symbol": "NVDA"}).status_code == 422
        assert client.get("/api/research/fx/gex", params={"symbol": "NVDA"}).status_code == 422
        no_contact = client.get("/api/research/us/risk-factors", params={"symbol": "NVDA"}).json()
        assert no_contact["reason"] == "sec_contact_missing"
        with_contact = client.get(
            "/api/research/us/risk-factors", params={"symbol": "NVDA"},
            headers={"X-SEC-Contact": "me@example.com"},
        ).json()
        assert with_contact["status"] == "ok"
    assert ("risk-factors", "NVDA", "me@example.com") in fake.calls
