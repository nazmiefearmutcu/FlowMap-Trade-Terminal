"""Capability fields a recording keeps, and the reading a replay reports."""

from __future__ import annotations

from collections.abc import Mapping

from flowmap_server.feeds.crypto import is_crypto_market

# The capability keys a recording keeps. They describe what the data is (depth
# provenance, tape kind, side and CVD provenance), so a replay reports the
# recorded truth instead of a fixed guess.
_RECORDED_CAPABILITY_KEYS = ("depth", "tape", "trade_side", "cvd")

# Recordings written before the capability was stored. Crypto venues always
# delivered exchange-true L2 depth, tick tape, side and CVD. Anything else gets
# the keyless equity reading: synthetic depth, polled tape, no side, no CVD.
_LEGACY_CRYPTO_CAPABILITY: dict[str, object] = {
    "depth": "L2", "tape": "tick", "trade_side": "exchange", "cvd": "exchange",
}

_LEGACY_OTHER_CAPABILITY: dict[str, object] = {
    "depth": "SYNTH", "tape": "poll", "trade_side": "na", "cvd": "na",
}


def recorded_capability(capability: Mapping[str, object]) -> dict[str, object]:
    """The honest subset of a live feed's capability that a recording keeps."""
    return {k: capability[k] for k in _RECORDED_CAPABILITY_KEYS if k in capability}


def replayed_capability(market: str, recorded: Mapping[str, object] | None) -> dict[str, object]:
    """Capability a replay of one recording reports.

    The keys the recording stored win. Keys it lacks (or a recording that
    predates the stored capability) fall back to the honest legacy reading for
    the market, never to the exchange-true values a crypto venue would claim.
    """
    default = _LEGACY_CRYPTO_CAPABILITY if is_crypto_market(market) else _LEGACY_OTHER_CAPABILITY
    stored = recorded_capability(recorded) if recorded else {}
    return {**default, **stored}
