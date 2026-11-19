import asyncio

import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import Session
from flowmap_server.feeds.base import BookState, CvdAnchor
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.feeds.equity_book import VenueBook
from flowmap_server.feeds.equity_public_tape import TapeState
from flowmap_server.proto.events import (
    MODE_L2,
    SIDE_BUY,
    SIDE_SELL,
    SIDE_SRC_PROVIDER,
    Marker,
    Trade,
)

NOW = 1_794_940_000_000_000_000


def test_public_tape_requires_explicit_server_opt_in():
    assert not Config().equity_public_tape
    assert Config.from_env({"FLOWMAP_EQUITY_PUBLIC_TAPE": "1"}).equity_public_tape
    with pytest.raises(ValueError):
        Config.from_env({"FLOWMAP_EQUITY_PUBLIC_TAPE": "maybe"})


@pytest.mark.asyncio
async def test_provider_trades_and_independent_real_depth_survive_scope_changes():
    current = NOW

    def clock():
        nonlocal current
        current += 50_000_000
        return current

    async def bars():
        return []

    async def books():
        return [VenueBook("bzx", ((155.0, 100.0),), ((155.1, 200.0),), ())]

    async def price():
        return None

    async def tape():
        yield TapeState(True, anchor_ns=NOW - 100_000_000)
        yield Trade(NOW, 155.05, 7.0, SIDE_BUY, SIDE_SRC_PROVIDER, "tickdb")
        yield TapeState(False, "connection lost")
        yield TapeState(True, anchor_ns=NOW + 100_000_000)
        yield Trade(NOW + 100_000_000, 155.04, 3.0, SIDE_SELL, SIDE_SRC_PROVIDER, "tickdb")
        await asyncio.Event().wait()

    feed = EquityFeed(
        "NVDA",
        Config(equity_public_tape=True, dt_equity_keyless_grid_ns=100_000_000),
        now_ns_fn=clock,
        bars_fn=bars,
        book_fn=books,
        price_fn=price,
        public_tape_fn=tape,
    )
    stream = feed.events()
    events = []
    try:
        async with asyncio.timeout(2):
            async for event in stream:
                events.append(event)
                if sum(isinstance(x, Trade) and x.venue == "tickdb" for x in events) == 2:
                    break
    finally:
        await stream.aclose()
    assert [x.available for x in events if isinstance(x, CvdAnchor)] == [True, False, True]
    assert any(isinstance(x, Marker) and x.kind == "gap" for x in events)
    assert any(isinstance(x, BookState) and len(x.bid_px) > 0 for x in events)
    assert feed.capability["depth"] == "L2-snapshot"
    assert feed.capability["cvd"] == "provider"
    assert feed.capability["trade_side"] == "provider"
    assert feed.capability["public_tape"] == "trial"


@pytest.mark.asyncio
async def test_cvd_anchor_subtracts_existing_baseline_without_retiming_executions():
    class Feed:
        market = "equity"
        symbol = "NVDA"
        capability = {"depth": "L2-snapshot", "public_tape": "trial", "cvd": "provider"}

        async def events(self):
            yield CvdAnchor(NOW)
            yield Trade(NOW - 200_000_000, 155.05, 7.0, SIDE_SELL, SIDE_SRC_PROVIDER, "tickdb")

    grid = Grid(
        GridCfg(
            tick=0.01,
            tick_multiple=1,
            dt_ns=10**9,
            p0=154.0,
            rows=256,
            ring_columns=32,
            mode=MODE_L2,
        )
    )
    grid.on_trade(NOW - 10**9, 155.0, 1000.0, SIDE_BUY)
    feed = Feed()
    session = Session("scope-test", feed=feed, grid=grid)
    await session._consume_events()
    assert feed.capability["cvd_offset"] == 1000.0
    assert feed.capability["cvd_anchor_ns"] == str(NOW)
    assert grid.cvd_cumulative - feed.capability["cvd_offset"] == -7.0
    assert session._tape[-1].ts_ns == NOW - 200_000_000
