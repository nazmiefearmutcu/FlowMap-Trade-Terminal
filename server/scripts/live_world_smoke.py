#!/usr/bin/env python
"""Manual LIVE smoke test for the world-equity feed. Real network, NOT a pytest test.

Runs :class:`GlobalEquityFeed` for each ``SYMBOL@MIC`` given (or a default set spanning the
depth tiers), consumes events for ``--duration`` seconds each, concurrently, and reports per
listing: the stated capability, event counts, the book shape and whether the two things a chart
needs arrived: depth to draw (``heatmap``) and prints for the tape (``tape``).

Exit status 0 iff every listing whose market is open produced depth.

Usage::

    .venv/bin/python scripts/live_world_smoke.py --duration 40 THYAO@XIST 2330@XTAI
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import Counter

from flowmap_server.config import Config
from flowmap_server.feeds.base import BarSample, BookState
from flowmap_server.feeds.global_equity import GlobalEquityFeed, close_live_feed
from flowmap_server.proto.events import BBO, Marker, Trade

DEFAULT = [
    "2330@XTAI", "600519@XSHG", "000001@XSHE", "005930@XKRX", "VNM@XSTC", "RELIANCE@XNSE",
    "SAP@XETR", "D05@XSES", "NESN@XSWX", "PKO@XWAR", "EMAAR@XDFM", "QNBK@DSMD",
    "THYAO@XIST", "VOD@XLON", "7203@XJPX", "MC@XPAR", "ENEL@XMIL", "NPN@XJSE",
    "2222@XSAU", "BHP@XASX", "PETR4@BVMF", "SHOP@XTSE", "KAP@AIXK", "DANGCEM@XNSA",
]


async def run_one(spec: str, duration: float) -> tuple[str, bool, bool, bool, str]:
    symbol, _, mic = spec.partition("@")
    feed = GlobalEquityFeed(symbol, mic, Config())
    closed = feed.is_closed_now()
    counts: Counter[str] = Counter()
    depth_books = 0
    two_sided = 0
    levels = (0, 0)
    markers: list[str] = []
    first_trade: Trade | None = None
    deadline = time.monotonic() + duration
    gen = feed.events()
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
    tape = counts["Trade"] > 0
    line = (
        f"{spec:16} {'closed' if closed else 'open':6} depth={feed.capability['depth']:11} "
        f"book={counts[BookState.__name__]:4} (two-sided {two_sided:4}, levels {levels[0]}/{levels[1]}) "
        f"bars={counts[BarSample.__name__]:4} bbo={counts[BBO.__name__]:3} trades={counts[Trade.__name__]:3} "
        f"heatmap={'yes' if heatmap else 'NO '} tape={'yes' if tape else 'no '} "
        f"{'first trade ' + str((first_trade.price, first_trade.size, first_trade.venue)) if first_trade else ''} "
        f"{markers[:2] if markers else ''}"
    )
    return spec, closed, heatmap, tape, line


async def run(args: argparse.Namespace) -> int:
    specs = args.listings or DEFAULT
    results = await asyncio.gather(*(run_one(spec, args.duration) for spec in specs))
    await close_live_feed()
    failed = 0
    for _spec, closed, heatmap, _tape, line in results:
        print(line)
        if not closed and not heatmap:
            failed += 1
    opened = sum(1 for _s, closed, *_rest in results if not closed)
    print(f"\n{len(results)} listings, {opened} open; open without depth: {failed}")
    print(f"SMOKE {'PASS' if failed == 0 else 'FAIL'}")
    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("listings", nargs="*", help="SYMBOL@MIC, e.g. THYAO@XIST")
    parser.add_argument("--duration", type=float, default=40.0, help="seconds per listing")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
