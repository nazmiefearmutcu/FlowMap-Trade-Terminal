"""ReplayFeed unit tests — pacing, controls, and synthesized snapshots.

The feed replays a real Recorder round-trip (SimFeed.generate_history →
parquet → load_all) so the synthesized BookState path is exercised against
genuine recorded data, not a hand-built fixture. Streaming tests drive ONE
events() generator each and ``aclose()`` it explicitly — the feed parks
forever at end-of-recording, so abandoning the generator is the exit.
"""

from __future__ import annotations

import asyncio

import numpy as np
import pytest

from flowmap_server.core.record import Recorder
from flowmap_server.feeds.equity import _CAPABILITY
from flowmap_server.feeds.replay import ReplayFeed, unrecorded_capability
from flowmap_server.feeds.sim import SimFeed
from flowmap_server.proto import events
from flowmap_server.proto.events import EpochParams

DT_NS = 250_000_000
MARKET, SYMBOL = "sim", "SIM-DEMO"
ROWS = 2048
P0 = round((100.0 - ROWS * 0.5 / 2.0) / 0.5) * 0.5
EPOCH0 = EpochParams(epoch=0, tick=0.5, tick_multiple=1, dt_ns=DT_NS, p0=P0, rows=ROWS)


def _recorded_tail(tmp_path, n_cols: int):
    cols = SimFeed.generate_history(seed=7, n_cols=n_cols)
    rec = Recorder(tmp_path / "rec", 20.0)
    s = rec.open_session(MARKET, SYMBOL)
    s.record_epoch(EPOCH0)
    for c in cols:
        s.record_column(c)
    s.flush()
    s.close()
    tail = rec.load_all(MARKET, SYMBOL)
    assert tail is not None and len(tail.columns) == n_cols
    return tail


def _make_feed(tmp_path, n_cols: int, speed: float = 1.0) -> ReplayFeed:
    tail = _recorded_tail(tmp_path, n_cols)
    return ReplayFeed(market=MARKET, symbol=SYMBOL, tail=tail, speed=speed)


async def test_fast_replay_delivers_every_recorded_column(tmp_path):
    feed = _make_feed(tmp_path, n_cols=10, speed=1e6)
    gen = feed.events()
    books = []
    async with asyncio.timeout(5):
        while len(books) < 10:
            ev = await gen.__anext__()
            if ev.__class__.__name__ == "BookState":
                books.append(ev)
    await gen.aclose()
    # One synthesized snapshot per recorded column, in order, at the column's t0.
    assert [b.ts_ns for b in books] == [i * DT_NS for i in range(10)]
    first = books[0]
    assert len(first.bid_px) == len(first.bid_sz) and len(first.bid_px) > 0
    assert np.all(np.isfinite(first.bid_px)) and np.all(first.bid_sz > 0)


async def test_pause_freezes_the_clock_until_resume(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    feed.control(events.Pause())
    t1 = feed._clock.now()
    await asyncio.sleep(0.15)
    assert feed._clock.now() == t1, "a paused replay clock must not advance"

    feed.control(events.Resume())
    await asyncio.sleep(0.15)
    assert feed._clock.now() > t1, "resume releases the clock"


async def test_seek_jumps_cursor_and_streams_from_there(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    feed.control(events.Seek(t=5 * DT_NS))
    assert feed._cursor == 5, "cursor lands on the interval containing t"

    gen = feed.events()
    ev = await asyncio.wait_for(gen.__anext__(), 5)
    assert ev.ts_ns == 5 * DT_NS
    await gen.aclose()


async def test_set_speed_accelerates_delivery(tmp_path):
    feed = _make_feed(tmp_path, n_cols=12, speed=1.0)
    gen = feed.events()
    first = await asyncio.wait_for(gen.__anext__(), 5)
    assert first.ts_ns == 0

    # At 1× the next column is 250 ms away; a 10 000× speed must make it
    # arrive near-instantly.
    feed.control(events.SetSpeed(x=10_000))
    second = await asyncio.wait_for(gen.__anext__(), 0.5)
    assert second.ts_ns == DT_NS
    await gen.aclose()


async def test_end_of_recording_parks_instead_of_ending(tmp_path):
    feed = _make_feed(tmp_path, n_cols=4, speed=1e6)
    gen = feed.events()
    got = 0
    async with asyncio.timeout(5):
        while got < 4:
            await gen.__anext__()
            got += 1
    # Past the last column the feed must NOT stop (StopAsyncIteration would
    # tear the session down) — it parks and holds.
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(gen.__anext__(), 0.4)
    await gen.aclose()


async def _next_book(gen):
    while True:
        ev = await asyncio.wait_for(gen.__anext__(), 5)
        if ev.__class__.__name__ == "BookState":
            return ev


async def test_mid_stream_backward_seek_replays_from_target(tmp_path):
    """A Seek issued WHILE streaming rewinds immediately. The old control
    loop read the cursor once at generator start: a mid-stream rewind
    stalled while the wall clock caught up with the seeked-back target,
    then kept playing FORWARD from the old position — the seeked-back
    columns never replayed."""
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    gen = feed.events()
    books = [await _next_book(gen) for _ in range(5)]
    assert [b.ts_ns for b in books] == [i * DT_NS for i in range(5)]

    feed.control(events.Seek(t=2 * DT_NS))
    ev = await _next_book(gen)
    assert ev.ts_ns == 2 * DT_NS, "backward seek mid-stream must replay from the target"
    await gen.aclose()


async def test_mid_stream_forward_seek_skips_ahead(tmp_path):
    """Same cursor re-read contract, forward direction: columns between the
    old position and the seek target are skipped, not streamed first."""
    feed = _make_feed(tmp_path, n_cols=12, speed=1e6)
    gen = feed.events()
    first = await _next_book(gen)
    second = await _next_book(gen)
    assert [first.ts_ns, second.ts_ns] == [0, DT_NS]

    feed.control(events.Seek(t=8 * DT_NS))
    ev = await _next_book(gen)
    assert ev.ts_ns == 8 * DT_NS
    await gen.aclose()


def test_unrecorded_keyless_equity_replays_as_synth_never_real_l2(tmp_path):
    """A keyless equity recording stored before its capability was persisted
    must not replay as the real L2 ramp with exchange-side trades."""
    feed = ReplayFeed(market="equity", symbol="AAPL", tail=_recorded_tail(tmp_path, 4))
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["trade_side"] == "na"
    assert feed.capability["cvd"] == "na"
    assert feed.capability["replay"] is True
    assert feed.capability["depth_provenance"] == "recorded-density"


def test_unrecorded_crypto_recording_never_claims_exchange_side(tmp_path):
    feed = ReplayFeed(market="binance-spot", symbol="BTCUSDT", tail=_recorded_tail(tmp_path, 4))
    assert feed.capability["depth"] != "L2"
    # The stand-in is the snapshot tier the client badges as L2-SNAPSHOT.
    assert feed.capability["depth"] == "L2-snapshot"
    assert feed.capability["trade_side"] == "na"
    assert feed.capability["cvd"] == "na"


def test_replayed_sim_recording_is_flagged_synthetic_even_with_recorded_l2(tmp_path):
    # The sim declares a full L2 book (its wire mode depends on it), so the
    # honesty flag, not the depth tier, is what marks a replayed sim as generated.
    recorded = {"depth": "L2", "tape": "tick", "trade_side": "exchange", "cvd": "exchange"}
    feed = ReplayFeed(
        market="sim", symbol="SIM-DEMO", tail=_recorded_tail(tmp_path, 4),
        recorded_capability=recorded,
    )
    assert feed.capability["depth"] == "L2"
    assert feed.capability["synthetic"] is True


def test_replayed_keyless_equity_recording_is_not_synthetic(tmp_path):
    """Its prices and trades were observed; only the depth tier is SYNTH. The
    sim badge keys on ``synthetic``, so this must not carry it."""
    feed = ReplayFeed(market="equity", symbol="AAPL", tail=_recorded_tail(tmp_path, 4))
    assert feed.capability["depth"] == "SYNTH"
    assert feed.capability["synthetic"] is False
    assert feed.capability["depth_provenance"] == "recorded-density"


def test_replayed_sim_market_stays_synthetic_whatever_depth_was_recorded(tmp_path):
    recorded = {"depth": "SYNTH", "tape": "tick", "trade_side": "na", "cvd": "na"}
    feed = ReplayFeed(
        market="sim", symbol="SIM-DEMO", tail=_recorded_tail(tmp_path, 4),
        recorded_capability=recorded,
    )
    assert feed.capability["synthetic"] is True


def test_replayed_crypto_recording_is_not_flagged_synthetic(tmp_path):
    feed = ReplayFeed(market="binance-spot", symbol="BTCUSDT", tail=_recorded_tail(tmp_path, 4))
    assert feed.capability["synthetic"] is False


def test_replayed_keyed_equity_recording_is_not_flagged_synthetic(tmp_path):
    recorded = {"depth": "L1", "tape": "tick", "trade_side": "inferred", "cvd": "inferred"}
    feed = ReplayFeed(
        market="equity", symbol="AAPL", tail=_recorded_tail(tmp_path, 4),
        recorded_capability=recorded,
    )
    assert feed.capability["depth"] == "L1"
    assert feed.capability["synthetic"] is False


def test_unrecorded_stand_in_matches_keyless_equity_tier():
    """The equity stand-in is the keyless tier's own honesty fields, so the two
    cannot drift apart."""
    keyless = _CAPABILITY["keyless"]
    stand_in = unrecorded_capability("equity")
    for key in ("depth", "tape", "trade_side", "cvd"):
        assert stand_in[key] == keyless[key]


def test_stored_live_capability_is_replayed_as_recorded(tmp_path):
    recorded = {
        "depth": "L1",
        "tape": "tick",
        "trade_side": "inferred",
        "cvd": "inferred",
        "markers": ["session_break"],
        "replay": False,
    }
    feed = ReplayFeed(
        market="equity", symbol="AAPL", tail=_recorded_tail(tmp_path, 4),
        recorded_capability=recorded,
    )
    assert feed.capability["depth"] == "L1"
    assert feed.capability["tape"] == "tick"
    assert feed.capability["trade_side"] == "inferred"
    assert feed.capability["cvd"] == "inferred"
    assert "markers" not in feed.capability, "markers are the server's, not the recording's"
    assert feed.capability["replay"] is True, "the replay flag is this server's statement"


def test_partial_stored_capability_keeps_honest_defaults_for_missing_keys(tmp_path):
    feed = ReplayFeed(
        market="equity", symbol="AAPL", tail=_recorded_tail(tmp_path, 4),
        recorded_capability={"depth": "L1"},
    )
    assert feed.capability["depth"] == "L1"
    assert feed.capability["tape"] == "poll"
    assert feed.capability["trade_side"] == "na"
    assert feed.capability["cvd"] == "na"
