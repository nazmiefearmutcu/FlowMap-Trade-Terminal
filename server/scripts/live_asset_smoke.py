#!/usr/bin/env python
"""Manual LIVE smoke test for the asset markets. Real network, NOT a pytest test.

Runs :class:`AssetMarketFeed` for each ``MARKET:SYMBOL`` given (or a default set spanning
futures, currencies, indices and bonds), consumes events for ``--duration`` seconds each,
concurrently, and reports per instrument: the stated capability, event counts and whether the
two things a chart needs arrived: depth to draw (``heatmap``) and prints for the tape
(``tape``). It then reads each market's board once, as the symbol picker does, and the option
chain of three instruments that have one, as the option chain dialog does.

Exit status 0 iff every instrument produced depth, every board listed something and every
option chain came back with strikes.

Usage::

    .venv/bin/python scripts/live_asset_smoke.py --duration 40 'futures-eurex:FDAX1!' forex:EURUSD
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter

from flowmap_server.config import Config
from flowmap_server.feeds.asset_markets import (
    AssetMarketFeed,
    asset_backfill_fn,
    asset_board,
    asset_symbol,
    close_asset_feed,
)
from flowmap_server.feeds.base import BarSample, BookState
from flowmap_server.feeds.option_chains import OptionChains, close_published_chains
from flowmap_server.proto.events import Marker, Trade

DEFAULT = [
    "futures-cme_mini:ES1!", "futures-nymex:CL1!", "futures-comex:GC1!", "futures-eurex:FDAX1!",
    "futures-bist:XU030D1!", "futures-nse:NIFTY1!", "forex:EURUSD", "forex:USDTRY",
    "indices:SP:SPX", "indices:BIST:XU100", "indices:TVC:DXY", "bonds:US10Y", "bonds:TR10Y",
]


OPTION_CHAINS = [
    ("equity", "AAPL"),
    ("indices", "SP:SPX"),
    ("world-xist", "THYAO"),
    ("indices", "NSE:NIFTY"),
    ("binance-spot", "BTCUSDT"),
    ("deribit", "ETH-PERPETUAL"),
]
"""Instruments with a chain, one per publisher path: a US share and a US index (Cboe), a Borsa
Istanbul share and an NSE index (the scanner), a coin on a venue without options (Bybit) and a
coin on Deribit."""


async def run_one(spec: str, duration: float) -> tuple[str, bool, str]:
    market, _, symbol = spec.partition(":")
    candles = await asset_backfill_fn(market, symbol, max_cols=600, now_ns=time.time_ns())
    feed = AssetMarketFeed(symbol, market, Config())
    closed = feed.is_closed_now()
    counts: Counter[str] = Counter()
    depth_books = 0
    two_sided = 0
    levels = (0, 0)
    markers: list[str] = []
    first_trade: Trade | None = None
    deadline = time.monotonic() + duration
    gen = feed.closed_history_events() if closed else feed.events()
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                event = await asyncio.wait_for(anext(gen), timeout=remaining)
            except (StopAsyncIteration, TimeoutError):
                break
            counts[type(event).__name__] += 1
            if isinstance(event, BookState):
                if len(event.bid_px) or len(event.ask_px):
                    depth_books += 1
                    levels = (len(event.bid_px), len(event.ask_px))
                if len(event.bid_px) and len(event.ask_px):
                    two_sided += 1
            elif isinstance(event, Trade):
                first_trade = first_trade or event
            elif isinstance(event, Marker):
                markers.append(f"{event.kind}:{event.text[:40]}")
    finally:
        await gen.aclose()
    heatmap = depth_books > 0
    line = (
        f"{spec:24} {'closed' if closed else 'open':6} basis={feed.capability['profile_basis']:6} "
        f"backfill={len(candles):4} book={counts[BookState.__name__]:4} "
        f"(two-sided {two_sided:4}, levels {levels[0]}/{levels[1]}) "
        f"bars={counts[BarSample.__name__]:4} trades={counts[Trade.__name__]:3} "
        f"heatmap={'yes' if heatmap else 'NO '} tape={'yes' if counts['Trade'] else 'no '} "
        f"{'first trade ' + str((first_trade.price, first_trade.size, first_trade.venue)) if first_trade else ''} "
        f"{markers[:2] if markers else ''}"
    )
    return spec, heatmap, line


async def run(args: argparse.Namespace) -> int:
    specs = args.instruments or DEFAULT
    results = await asyncio.gather(*(run_one(spec, args.duration) for spec in specs))
    failed = 0
    for _spec, heatmap, line in results:
        print(line)
        if not heatmap:
            failed += 1
    empty = 0
    for market in dict.fromkeys(spec.partition(":")[0] for spec in specs):
        rows = await asset_board(market)
        priced = sum(1 for row in rows if row.last is not None)
        head = [asset_symbol(row) for row in rows[:4]]
        print(f"board {market:18} rows={len(rows):5} priced={priced:5} head={head}")
        if not rows:
            empty += 1
    chains = OptionChains()
    chainless = 0
    for market, symbol in OPTION_CHAINS:
        view = await chains.view(market, symbol)
        strikes = view["strikes"]
        series = view["series"]
        assert isinstance(strikes, list) and isinstance(series, list)
        paired = sum(1 for row in strikes if row["call"] and row["put"])
        print(
            f"options {market}:{symbol:10} source={view['source']} status={view['status']} "
            f"underlying={view['underlying']} "
            f"series={len(series)} selected={view['selected']} "
            f"strikes={len(strikes)} both_sides={paired}"
        )
        if view["status"] != "ok" or not strikes:
            chainless += 1
    await close_asset_feed()
    await close_published_chains()
    print(
        f"\n{len(results)} instruments; without depth: {failed}; empty boards: {empty}; "
        f"option chains without strikes: {chainless}"
    )
    passed = failed == 0 and empty == 0 and chainless == 0
    print(f"SMOKE {'PASS' if passed else 'FAIL'}")
    return 0 if passed else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("instruments", nargs="*", help="MARKET:SYMBOL, e.g. forex:EURUSD")
    parser.add_argument("--duration", type=float, default=40.0, help="seconds per instrument")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
