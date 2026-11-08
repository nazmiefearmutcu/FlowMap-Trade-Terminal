"""A recording keeps the live capability it was made under, and replay reports it.

A synthetic equity run must never replay as real L2 depth with exchange-side
trades, and a recording that predates the stored capability must not be
reported as one either.
"""

from __future__ import annotations

from flowmap_server.config import Config
from flowmap_server.core.record import Recorder
from flowmap_server.core.session import SessionManager, replayed_capability
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto.events import EpochParams

MARKET, SYMBOL = "equity", "SYNTH-DEMO"
DT_NS = 250_000_000
ROWS = 32
EPOCH = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=92.0, rows=ROWS)
KEYLESS_SYNTH = {"depth": "SYNTH", "tape": "poll", "trade_side": "na", "cvd": "na"}
CRYPTO_L2 = {"depth": "L2", "tape": "tick", "trade_side": "exchange", "cvd": "exchange"}


def _record(rec: Recorder, capability: dict[str, object] | None) -> None:
    writer = rec.open_session(MARKET, SYMBOL, capability=capability)
    writer.record_epoch(EPOCH)
    for column in SimFeed.generate_history(seed=3, n_cols=8, start_ns=0, rows=ROWS):
        writer.record_column(column)
    writer.close()


def _tail(rec: Recorder):
    tail = rec.load_tail(MARKET, SYMBOL, max_age_ns=2**62, now_ns=2**62, limit_cols=100)
    assert tail is not None
    return tail


def test_recorded_capability_round_trips_through_tail_load(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    _record(rec, KEYLESS_SYNTH)

    assert _tail(rec).capability == KEYLESS_SYNTH


def test_recording_without_capability_loads_as_none(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    _record(rec, None)

    assert _tail(rec).capability is None


def test_replay_of_recorded_synth_equity_reports_synth_not_l2(tmp_path):
    rec = Recorder(tmp_path, 20.0)
    _record(rec, KEYLESS_SYNTH)
    manager = SessionManager(Config(), recorder=rec)

    feed, tail = manager._replay_feed_blocking(MARKET, SYMBOL, None, None)

    assert tail.capability == KEYLESS_SYNTH
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["trade_side"] == "na"
    assert feed.capability["cvd"] == "na"
    assert feed.capability["replay"] is True
    assert feed.capability["depth_provenance"] == "recorded-density"
    # ``synthetic`` means generated prices and trades. A keyless equity run
    # recorded real prices and trades, only its depth is synthetic.
    assert feed.capability["synthetic"] is False


def test_legacy_equity_recording_defaults_to_honest_synth_reading():
    assert replayed_capability(MARKET, None) == KEYLESS_SYNTH


def test_legacy_crypto_recording_keeps_exchange_true_reading():
    assert replayed_capability("binance-spot", None) == CRYPTO_L2


def test_stored_capability_overrides_the_market_default():
    keyed = {"depth": "L1_BAND", "tape": "tick", "trade_side": "inferred"}

    assert replayed_capability(MARKET, keyed) == {**KEYLESS_SYNTH, **keyed}
