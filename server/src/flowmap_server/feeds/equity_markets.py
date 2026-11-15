"""What counts as an equity-model market, and the type the session layer tests for it.

Kept apart from :mod:`flowmap_server.feeds.equity` so the US feed module stays within its
size budget and the synthetic feed family (:mod:`flowmap_server.feeds.equity_synth`) can
share the base type without importing the US feed.
"""

from __future__ import annotations

__all__ = ["EQUITY_MARKET", "EQUITY_MARKETS", "EquityFeedBase", "is_equity_market"]

# Subscribe.market string routed to EquityFeed by the session feed factory.
EQUITY_MARKET = "equity"
EQUITY_MARKETS = frozenset({EQUITY_MARKET})
# One exchange of the world venue: ``world-<mic>`` (see feeds.global_equity).
_WORLD_PREFIX = "world-"
# The asset venues (see feeds.asset_markets): one derivatives exchange, or a whole kind.
_FUTURES_PREFIX = "futures-"
_ASSET_MARKETS = frozenset({"forex", "indices", "bonds"})


def is_equity_market(market: str) -> bool:
    """True for the US ``equity`` market, every ``world-<mic>`` exchange market and the asset
    markets (``futures-<venue>``, ``forex``, ``indices``, ``bonds``).

    All are served by an :class:`EquityFeedBase` (the US market by :class:`EquityFeed`, the
    world and asset markets by subclasses of ``SynthEquityFeed``), so the session layer gives
    them the same grid and the same closed-market handling. The prefix is the whole test
    here: whether the MIC or venue is one this build can reach is the router's question, and
    an unknown one never gets as far as a grid.
    """
    lowered = market.lower()
    return (
        market in EQUITY_MARKETS
        or lowered.startswith((_WORLD_PREFIX, _FUTURES_PREFIX))
        or lowered in _ASSET_MARKETS
    )


class EquityFeedBase:
    """The type the session layer tests for equity handling (calendar close, keyless tier).

    Both equity feed families derive from it: :class:`EquityFeed` (US, Cboe's book) and
    ``SynthEquityFeed`` (world exchanges and asset markets, synthetic profiles). It holds
    no behaviour; each family implements the whole Feed protocol itself.
    """

    __slots__ = ()
