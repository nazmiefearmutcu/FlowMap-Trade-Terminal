"""History replay gate: an open keyless equity feed replays its past-stamped session warmup.

Covers ``Session._note_history_replay``, ``_end_history_replay`` and the ``_consume`` finally.

Method: each test builds a real :class:`Session` over a scripted feed and drives it through
``Session._consume`` (the same entry the closed-market warmup tests use). Nothing sleeps and
nothing touches the network: the wall clock is injected (``wall_clock=lambda: NOW``), the guard
timer is a :class:`FakeTimer` that the test fires by hand, and the client is a recording stub.
The keyless feed is a real ``EquityFeed`` (so ``isinstance`` and ``tier`` behave as in
production) whose ``events()`` yields a script. The one exception is test 8, which drives
``_note_history_replay`` and ``_end_history_replay`` directly, as the brief allows.
"""

from __future__ import annotations

import numpy as np
import pytest

from flowmap_server.config import Config
from flowmap_server.core.grid import Grid, GridCfg
from flowmap_server.core.session import Session
from flowmap_server.core.session_common import _REPLAY_MAX_S, _REPLAY_PAST_NS, _T_MAX
from flowmap_server.feeds.base import BookState
from flowmap_server.feeds.equity import EquityFeed
from flowmap_server.proto import events, wire

DT = 250_000_000  # grid column width, ns
SEC = 10**9
NOW = 1_800_000_000 * SEC  # the injected wall clock
PAST = NOW - 3 * 3600 * SEC  # three hours ago: a replayed warmup
PRESENT = NOW - 1 * SEC  # inside the _REPLAY_PAST_NS window: the present


# ---------------------------------------------------------------------------
# helpers


class FakeHandle:
    def __init__(self, delay_s, cb):
        self.delay_s, self.cb, self.cancelled = delay_s, cb, False

    def cancel(self):
        self.cancelled = True

    def fire(self):
        if not self.cancelled:
            self.cb()


class FakeTimer:
    def __init__(self):
        self.entries: list[FakeHandle] = []

    def __call__(self, delay_s, cb):
        handle = FakeHandle(delay_s, cb)
        self.entries.append(handle)
        return handle

    def guards(self) -> list[FakeHandle]:
        return [h for h in self.entries if h.delay_s == _REPLAY_MAX_S]


class Offer:
    def __init__(self, msg_bytes, col_msg, protected):
        self.msg_bytes, self.col_msg, self.protected = msg_bytes, col_msg, protected


class RecordingClient:
    """Stands in for ClientTx: records every offer the session makes to it."""

    def __init__(self):
        self.offers: list[Offer] = []
        self.on_lag_drop = None

    def offer(self, msg_bytes, *, col_msg, t0_ns=None, protected=False, is_partial=False,
              partial_kind="", latest_key=""):
        self.offers.append(Offer(msg_bytes, col_msg, protected))

    def protected_count(self) -> int:
        return sum(1 for o in self.offers if o.protected)

    def column_count(self) -> int:
        return sum(1 for o in self.offers if o.col_msg)


def _grid_cfg() -> GridCfg:
    return GridCfg(
        tick=0.5, tick_multiple=1, dt_ns=DT, p0=84.0, rows=64,
        ring_columns=1024, mode=events.MODE_L2,
    )


def _book(ts_ns: int, mid: float = 100.0) -> BookState:
    px = np.array([mid - 1.0, mid - 0.5, mid], dtype=np.float64)
    return BookState(
        ts_ns=ts_ns, bid_px=px, bid_sz=np.full(3, 5.0), ask_px=px + 0.5, ask_sz=np.full(3, 5.0),
    )


def _past_books(n: int, start: int = PAST) -> list[BookState]:
    return [_book(start + i * DT) for i in range(n)]


def _trade(ts_ns: int) -> events.Trade:
    return events.Trade(
        ts_ns=ts_ns, price=100.0, size=1.0, side=events.SIDE_BUY,
        side_src=events.SIDE_SRC_EXCHANGE, venue="TEST",
    )


async def _no_bars():
    return []


async def _no_sleep(_s: float) -> None:
    return None


class ScriptedKeylessFeed(EquityFeed):
    """A real keyless EquityFeed whose events() yields the test's script.

    The base constructor is only given fakes (no bars fetch, no price poll, a fixed clock), so
    nothing runs unless the session consumes it, and then only the script runs.
    """

    def __init__(self, script):
        super().__init__(
            "AAPL", Config(), now_ns_fn=lambda: NOW, bars_fn=_no_bars, sleep_fn=_no_sleep,
        )
        self._script = script

    async def events(self):
        async for ev in self._script(self):
            yield ev


class ScriptedKeyedFeed(ScriptedKeylessFeed):
    """Same script, but an EquityFeed on a keyed tier: must never replay."""

    @property
    def tier(self) -> str:
        return "alpaca"


class ScriptedSimFeed:
    """A non-equity feed: same script shape, never a keyless equity feed."""

    market = "sim"
    symbol = "SIM"
    capability: dict[str, object] = {"depth": "L2"}

    def __init__(self, script):
        self._script = script

    async def events(self):
        async for ev in self._script(self):
            yield ev


def _session(feed, timer: FakeTimer | None = None) -> tuple[Session, FakeTimer]:
    timer = timer or FakeTimer()
    sess = Session(
        "replay-test",
        feed=feed,
        grid=Grid(_grid_cfg()),
        clock=lambda: 0,
        timer=timer,
        wall_clock=lambda: NOW,
    )
    return sess, timer


def _attach(sess: Session) -> RecordingClient:
    client = RecordingClient()
    sess.attach(client)
    return client


def _script(*items):
    """Build a script: each item is a BookState/Trade, or a callable run between yields."""

    async def run(_feed):
        for item in items:
            if callable(item):
                item()
            else:
                yield item

    return run


# ---------------------------------------------------------------------------
# 1. a replayed warmup fills the ring in silence


async def test_replayed_warmup_fills_ring_without_offering_columns():
    # The fixture stamps: PAST is outside the replay window, PRESENT inside it.
    assert PAST < NOW - _REPLAY_PAST_NS <= PRESENT
    seen: dict[str, int] = {}

    def checkpoint():
        # Runs when the feed has no more events: the replay is still open here, the
        # finally in _consume has not yet released the subscriber.
        seen["columns"] = client.column_count()
        seen["protected"] = client.protected_count()
        seen["ring"] = len(sess._grid.history(_T_MAX, 1024))

    sess, _ = _session(ScriptedKeylessFeed(_script(*_past_books(200), checkpoint)))
    client = _attach(sess)

    await sess._consume()

    assert seen["columns"] == 0, "no column frame may reach a client during the replay"
    assert seen["protected"] == 0, "the snapshot waits for the replay's end"
    assert seen["ring"] > 0, "the replayed columns must sit in the ring"


# ---------------------------------------------------------------------------
# 2. the snapshot goes out once, after the first present event; then live resumes


async def test_snapshot_offered_once_after_first_present_event_then_live_resumes():
    marks: dict[str, int] = {}

    def checkpoint(name: str):
        def _cb():
            marks[name] = client.protected_count()
        return _cb

    feed_items = [
        *_past_books(200),
        _book(PRESENT),  # P: the first present event, handled in silence
        _book(PRESENT + SEC),  # Q: the snapshot goes out just before this one
        checkpoint("after_q"),
        _trade(PRESENT + 2 * SEC),  # live from here on
        checkpoint("after_trade"),
    ]
    sess, _ = _session(ScriptedKeylessFeed(_script(*feed_items)))
    client = _attach(sess)

    await sess._consume()

    protected = client.protected_count()
    assert protected > 0, "the client must receive the snapshot"
    assert marks["after_q"] == protected, "the snapshot is complete once Q has been handled"
    assert marks["after_trade"] == protected, "the snapshot is offered exactly once"
    hellos = [o for o in client.offers if o.protected and b'"protocol_version"' in o.msg_bytes]
    assert len(hellos) == 1, "one snapshot: a single Hello heads it"
    trade_offers = [o for o in client.offers if not o.col_msg and not o.protected]
    assert trade_offers, "a live trade after the replay is broadcast normally"


# ---------------------------------------------------------------------------
# 3. the first event decides


async def test_first_present_event_means_no_replay_even_if_later_events_are_past():
    feed_items = [_book(PRESENT), *_past_books(50), _trade(PRESENT + SEC)]
    sess, timer = _session(ScriptedKeylessFeed(_script(*feed_items)))
    client = _attach(sess)

    await sess._consume()

    assert sess._history_replay == "live"
    assert timer.guards() == [], "no replay guard is armed"
    assert client.protected_count() == 0, "no snapshot is ever sent by a replay"
    assert any(not o.col_msg for o in client.offers), "the live trade is broadcast"


# ---------------------------------------------------------------------------
# 4. non-keyless feeds are never a replay


@pytest.mark.parametrize("feed_cls", [ScriptedSimFeed, ScriptedKeyedFeed], ids=["sim", "keyed-equity"])
async def test_non_keyless_feed_is_never_a_replay(feed_cls):
    sess, timer = _session(feed_cls(_script(*_past_books(200))))
    client = _attach(sess)

    await sess._consume()

    assert sess._history_replay == "live"
    assert timer.guards() == []
    assert client.protected_count() == 0
    assert client.column_count() > 0, "past-stamped columns on a non-keyless feed reach clients"


# ---------------------------------------------------------------------------
# 5. the guard timer


async def test_guard_timer_sends_snapshot_and_resumes_broadcast():
    seen: dict[str, object] = {}

    def fire_guard_mid_replay():
        guards = timer.guards()
        seen["guard_count"] = len(guards)
        seen["protected_before"] = client.protected_count()
        if guards:
            guards[0].fire()
        seen["protected_after"] = client.protected_count()
        seen["offers_after"] = len(client.offers)

    feed_items = [*_past_books(50), fire_guard_mid_replay, *_past_books(20, start=PAST + 50 * DT),
                  _trade(PRESENT)]
    sess, timer = _session(ScriptedKeylessFeed(_script(*feed_items)))
    client = _attach(sess)

    await sess._consume()

    assert seen["guard_count"] == 1, "exactly one guard is armed for the replay"
    assert seen["protected_before"] == 0
    assert seen["protected_after"] > 0, "the guard hands the snapshot out"
    assert client.protected_count() == seen["protected_after"], "and only once"
    assert sess._history_replay == "live"
    resumed = [o for o in client.offers[seen["offers_after"]:] if not o.protected]
    assert resumed, "broadcasting resumes after the guard fires"


async def test_normal_replay_end_cancels_the_guard():
    feed_items = [*_past_books(50), _book(PRESENT), _book(PRESENT + SEC)]
    sess, timer = _session(ScriptedKeylessFeed(_script(*feed_items)))
    client = _attach(sess)

    await sess._consume()

    guards = timer.guards()
    assert len(guards) == 1
    assert guards[0].cancelled, "the replay ended on its own, so the guard must be cancelled"
    assert client.protected_count() > 0


# ---------------------------------------------------------------------------
# 6. a feed that ends or raises mid replay still hands out the snapshot


async def test_feed_ending_mid_replay_still_sends_snapshot():
    sess, _ = _session(ScriptedKeylessFeed(_script(*_past_books(80))))
    client = _attach(sess)

    await sess._consume()

    assert sess._history_replay == "live"
    # The snapshot frames, then one Status: the state the feed reported while it was muted.
    assert client.protected_count() == len(sess._snapshot_frames()) + 1


async def test_feed_raising_mid_replay_still_sends_snapshot():
    async def failing(_feed):
        for ev in _past_books(80):
            yield ev
        raise RuntimeError("provider socket died")

    sess, _ = _session(ScriptedKeylessFeed(failing))
    client = _attach(sess)

    with pytest.raises(RuntimeError, match="provider socket died"):
        await sess._consume()

    assert sess._history_replay == "live"
    assert client.protected_count() > 0, "the finally in _consume must release the subscriber"


# ---------------------------------------------------------------------------
# 7. no client attached: the replay ends without error


async def test_replay_with_no_client_ends_quietly():
    feed_items = [*_past_books(60), _book(PRESENT), _book(PRESENT + SEC), _trade(PRESENT + 2 * SEC)]
    sess, timer = _session(ScriptedKeylessFeed(_script(*feed_items)))

    await sess._consume()  # must not raise

    assert sess._history_replay == "live"
    assert sess.client_count == 0
    assert timer.guards() and timer.guards()[0].cancelled


# ---------------------------------------------------------------------------
# 8. _end_history_replay is idempotent (drives the private methods directly)


async def test_end_history_replay_is_idempotent():
    sess, timer = _session(ScriptedKeylessFeed(_script()))
    client = _attach(sess)

    # Start a replay directly with a past-stamped book: this arms the guard.
    sess._note_history_replay(_book(PAST))
    assert sess._history_replay == "replay"
    assert len(timer.guards()) == 1

    sess._end_history_replay()
    first = client.protected_count()
    assert first > 0
    assert sess._history_replay == "live"
    assert timer.guards()[0].cancelled

    sess._end_history_replay()  # a second call changes nothing
    assert client.protected_count() == first
    assert sess._history_replay == "live"


async def test_end_history_replay_without_a_replay_is_a_noop():
    sess, _ = _session(ScriptedKeylessFeed(_script()))
    client = _attach(sess)

    sess._end_history_replay()

    assert client.protected_count() == 0
    assert sess._history_replay is None


# ---------------------------------------------------------------------------
# 9. a feed that withholds its depth still goes live, and its state is not lost


def _decoded(client: RecordingClient) -> list[object]:
    """Every event the client was offered, in order."""
    out: list[object] = []
    for offer in client.offers:
        offset = 0
        while offset < len(offer.msg_bytes):
            ev, offset = wire.decode(offer.msg_bytes, offset)
            if ev is not None:
                out.append(ev)
    return out


async def test_a_present_print_closes_the_replay_when_no_book_follows():
    # A keyless feed with a stale profile withholds its depth: after the replay it yields
    # prints and markers only. The first one stamped now must close the replay, not the
    # thirty second guard.
    sess, timer = _session(ScriptedKeylessFeed(_script(*_past_books(40), _trade(NOW), _trade(NOW + DT))))
    client = _attach(sess)
    before = len(client.offers)

    await sess._consume_events()

    assert sess._history_replay == "live"
    assert client.protected_count() > 0
    assert len(client.offers) > before
    # It ended on its own: the guard was cancelled, not fired.
    assert all(guard.cancelled for guard in timer.guards())


async def test_the_state_the_feed_reported_during_the_replay_is_stated_after_the_snapshot():
    sess, _ = _session(ScriptedKeylessFeed(_script(*_past_books(40))))
    client = _attach(sess)
    before = len(_decoded(client))

    for ev in _past_books(40):
        sess._note_history_replay(ev)
    # The feed reports itself degraded while every broadcast is muted.
    sess._set_feed_state("degraded")
    assert [type(ev).__name__ for ev in _decoded(client)[before:]] == []

    sess._end_history_replay()

    after = _decoded(client)[before:]
    statuses = [ev for ev in after if isinstance(ev, events.Status)]
    assert [status.feed_state for status in statuses] == ["degraded"]
    # The Status follows the snapshot it belongs to.
    assert isinstance(after[-1], events.Status)
    assert isinstance(after[0], events.Hello)

