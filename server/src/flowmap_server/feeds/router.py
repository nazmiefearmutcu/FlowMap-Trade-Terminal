"""The one place a ``Subscribe.market`` string becomes a :class:`Feed`.

The test path (``SessionManager``) and the server path (``api.app``) both call
this, so the two cannot drift apart. The only difference between them is the sim
feed's ``realtime`` flag, which is a parameter.

Market grammar:

``sim``                     the deterministic demo feed
``<exchange>[-<segment>]``  any crypto venue Crocodile can reach — the ten
                            hand-written connectors plus every ccxt venue id.
                            The optional segment picks a venue's market
                            (``binance-usdm``, ``bybit-linear``); venues that
                            encode it in the symbol take none (``okx``).
``equity``                  US equities, provider tier auto-selected from cfg

Unknown markets raise :class:`NotImplementedError`, which the WS layer turns
into close code 1003. The message names the shape rather than listing every
venue — a wall of ids is not a better error than a rule.
"""

from __future__ import annotations

from flowmap_server.config import Config
from flowmap_server.feeds.base import DropCounters, Feed
from flowmap_server.feeds.crypto import CryptoFeed, is_crypto_market, split_market
from flowmap_server.feeds.equity import EQUITY_MARKETS, EquityFeed
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events

__all__ = ["SIM_MARKET", "build_feed", "feed_factory"]

SIM_MARKET = "sim"



def build_feed(
    sub: events.Subscribe, cfg: Config, *, realtime_sim: bool, stats: DropCounters | None = None
) -> Feed:
    """Route one subscription to its feed.

    ``realtime_sim`` paces the demo feed to wall time (one column per ``dt_ns``,
    which keeps the event loop live and the stream watchable). Tests want the
    unpaced variant so they can drive the clock themselves. ``stats`` is the
    server-wide telemetry aggregate (duck-typed): when set, the
    live feeds count their queue evictions and ts-gate drops into it at the
    source instead of leaving them write-only.
    """
    if sub.market == SIM_MARKET:
        return SimFeed(seed=42, dt_ns=cfg.dt_crypto_ns, start_ns=0, realtime=realtime_sim,
                       symbol=sub.symbol)
    if sub.market in EQUITY_MARKETS:
        # Tier (keyless SYNTH / Alpaca / Finnhub) auto-selected from cfg keys.
        return EquityFeed(sub.symbol, cfg, stats=stats)
    if is_crypto_market(sub.market):
        exchange, segment = split_market(sub.market)
        return CryptoFeed(exchange=exchange, symbol=sub.symbol, market=segment, cfg=cfg, stats=stats)
    raise NotImplementedError(
        f"market {sub.market!r} has no feed — expected 'sim', "
        f"{sorted(EQUITY_MARKETS)}, or '<exchange>[-<segment>]' naming a crypto "
        f"venue this build can reach (see GET /api/venues)"
    )


def feed_factory(cfg: Config, *, realtime_sim: bool):
    """Bind *cfg* into the single-argument factory the session manager wants."""

    def factory(sub: events.Subscribe) -> Feed:
        return build_feed(sub, cfg, realtime_sim=realtime_sim)

    return factory
