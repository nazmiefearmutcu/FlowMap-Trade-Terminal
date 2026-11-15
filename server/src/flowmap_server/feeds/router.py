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
``world-<mic>``             one exchange anywhere, by ISO 10383 operating MIC
                            (``world-xist``, ``world-xtai``); the symbol is the
                            exchange's local symbol. Depth tier from Crocodile's
                            live source chain for that market.

Unknown markets raise :class:`NotImplementedError`, which the WS layer turns
into close code 1003. The message names the shape rather than listing every
venue — a wall of ids is not a better error than a rule.
"""

from __future__ import annotations

from flowmap_server.config import Config
from flowmap_server.feeds.base import DropCounters, Feed
from flowmap_server.feeds.crypto import CryptoFeed, is_crypto_market, split_market
from flowmap_server.feeds.equity import EQUITY_MARKETS, EquityFeed
from flowmap_server.feeds.asset_markets import AssetMarketFeed, is_asset_market
from flowmap_server.feeds.global_equity import GlobalEquityFeed, world_mic
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.feeds.eurex_official import MARKET as EUREX_MARKET, EurexOfficialFeed, EurexService
from pathlib import Path
from flowmap_server.proto import events

__all__ = ["SIM_MARKET", "build_feed", "feed_factory"]

SIM_MARKET = "sim"


def build_feed(
    sub: events.Subscribe, cfg: Config, *, realtime_sim: bool, stats: DropCounters | None = None,
    eurex_service: EurexService | None = None,
) -> Feed:
    """Route one subscription to its feed.

    ``realtime_sim`` paces the demo feed to wall time (one column per ``dt_ns``,
    which keeps the event loop live and the stream watchable). Tests want the
    unpaced variant so they can drive the clock themselves. ``stats`` is the
    server-wide telemetry aggregate (duck-typed): when set, the
    live feeds count their queue evictions and ts-gate drops into it at the
    source instead of leaving them write-only.
    """
    if sub.market == EUREX_MARKET:
        return EurexOfficialFeed(sub.symbol, eurex_service or _local_eurex(cfg))
    if sub.market == SIM_MARKET:
        # start_ns=0: the sim clock is session-relative (elapsed time from 0), not wall
        # time. Clients render these timestamps as elapsed T+, never as a clock time.
        return SimFeed(seed=42, dt_ns=cfg.dt_crypto_ns, start_ns=0, realtime=realtime_sim,
                       symbol=sub.symbol)
    if sub.market in EQUITY_MARKETS:
        # Tier (keyless SYNTH / Alpaca / Finnhub) auto-selected from cfg keys.
        return EquityFeed(sub.symbol, cfg, stats=stats)
    mic = world_mic(sub.market)
    if mic is not None:
        return GlobalEquityFeed(sub.symbol, mic, cfg, stats=stats)
    if is_asset_market(sub.market):
        return AssetMarketFeed(sub.symbol, sub.market, cfg, stats=stats)
    if is_crypto_market(sub.market):
        exchange, segment = split_market(sub.market)
        return CryptoFeed(exchange=exchange, symbol=sub.symbol, market=segment, cfg=cfg, stats=stats)
    raise NotImplementedError(
        f"market {sub.market!r} has no feed — expected 'sim', "
f"{sorted(EQUITY_MARKETS)}, 'world-<mic>', 'futures-<venue>', 'forex', 'indices', 'bonds', "
        f"or '<exchange>[-<segment>]' naming a crypto "
        f"venue this build can reach (see GET /api/venues)"
    )


def feed_factory(cfg: Config, *, realtime_sim: bool, eurex_service: EurexService | None = None):
    """Bind *cfg* into the single-argument factory the session manager wants."""

    def factory(sub: events.Subscribe) -> Feed:
        return build_feed(sub, cfg, realtime_sim=realtime_sim, eurex_service=eurex_service)

    return factory


_local_services: dict[str, EurexService] = {}


def _local_eurex(cfg: Config) -> EurexService:
    """Bare test/CLI factory ownership; the application injects its own lifecycle owner."""
    key = str(Path(cfg.data_dir).expanduser().resolve())
    if key not in _local_services:
        _local_services[key] = EurexService(Path(key), ring_columns=cfg.ring_columns)
    return _local_services[key]
