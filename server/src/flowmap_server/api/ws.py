"""Binary WebSocket endpoint.

One connection owns one :class:`ClientTx` and at most one Session
subscription. Three concurrent pieces per connection, all torn down together
in ``finally`` (no task leaks):

- **receive loop** (the endpoint coroutine): decodes batched control
  messages with the :mod:`wire` loop — unknown types skip via payload_len;
  a MALFORMED message (or a text frame on the binary-only protocol) is
  logged and the remainder of that frame is dropped (batched bytes cannot
  be resynced mid-frame), but the connection itself SURVIVES — one bad
  message must never kill a healthy stream. A dispatch error is likewise
  logged and swallowed; the receive loop only exits on a real disconnect
  or a deliberate refusal close;
- **flush loop**: every 16 ms (~60 Hz, for smooth live presentation) drains
  the ClientTx queue up to 256 KiB and sends each drained frame as one
  binary WS message;
- **ping loop**: after the initial Hello is sent, ~1 Hz
  ``Ping{server_send_ns}`` is the only clock and
  latency mechanism; the steady 1 Hz cadence doubles as the application-
  level keepalive that stops intermediate proxies from idling the socket.
  ``Pong`` updates the connection's latency estimate, which feeds the
  manager's stats producer (``stats.record_rtt``) and the refusal Status
  frames. The session's Status broadcasts read the same measurements through
  ``Session.conn_stats``, installed at subscribe.

A Subscribe is served by its own task, bounded by ``SUBSCRIBE_DEADLINE_S``,
while the receive loop keeps reading. A peer close cancels it. Frames that
arrive meanwhile apply in order once the subscription is attached, except
keepalive replies, which are never held back.

All sends go through one lock so control-plane replies (HistoryResponse,
refusal Status) never interleave mid-frame with queue flushes or pings.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

import msgspec
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from flowmap_server.api import _env
from flowmap_server.core.session import (
    ClientTx,
    ReplayUnavailableError,
    Session,
    SessionLimitError,
    SessionManager,
)
from flowmap_server.data.venues import UnlistedSymbolError
from flowmap_server.feeds._yahoo import UnknownSymbolError
from flowmap_server.proto import events, wire

__all__ = ["router"]

logger = logging.getLogger(__name__)

router = APIRouter()

FLUSH_INTERVAL_S = 0.016  # ~60 Hz; do not hold live ticks in 50 ms batches
FLUSH_MAX_BYTES = 256 * 1024
PING_INTERVAL_S = 1.0
# While a subscribe prepares (before the Hello), a progress Status this often
# keeps the client's handshake window open. Shorter than the client's 8 s window.
SUBSCRIBE_PROGRESS_S = 2.0
# Hard bound on one subscribe (venue discovery, recording boot, snapshot). It
# sits below the client's 60 s handshake ceiling, so a stuck subscribe is
# refused with a Status the client can read instead of the client abandoning
# the socket while this side still waits.
SUBSCRIBE_DEADLINE_S = 45.0
# A send that cannot complete within this window means the peer is gone or
# black-holed (TCP send buffers full, no FIN ever coming): abort the connection
# rather than stalling the flush/ping loops forever.
SEND_TIMEOUT_S = 10.0
# A connection that has sent us NOTHING (not even an application Pong — the
# FlowMap client answers every server Ping) for this long is dead: without this
# check a black-holed peer pins its Session refcount + flush/ping tasks forever.
LIVENESS_TIMEOUT_S = 30.0
# Inbound flow control. A legitimate client sends a few control
# messages a second (Pong, Subscribe, HistoryRequest bursts while scrolling).
# Each frame costs one token and each further message batched in it costs one
# more. Work beyond this burst, refilled at the sustained rate, means a flood:
# the socket is closed rather than letting it burn CPU on decode.
INBOUND_BURST_FRAMES = 256
INBOUND_FRAMES_PER_S = 100.0
# Pings whose Pong may still arrive. Only an echo of one of these is a sample.
PING_OUTSTANDING_MAX = 16
# Largest round trip accepted as a latency sample.
PONG_RTT_MAX_NS = 60_000_000_000

# WS close codes
_CLOSE_UNSUPPORTED = 1003  # market has no feed at this milestone
_CLOSE_POLICY = 1008  # origin violated the endpoint's policy
_CLOSE_TRY_AGAIN_LATER = 1013  # session limit reached / connection cap reached
_CLOSE_INTERNAL = 1011  # unexpected server-side failure while serving the request

# Refusal reason carried in Status.capability["reason"] (the client parks on it).
REASON_INVALID_SYMBOL = "invalid_symbol"
REASON_SUBSCRIBE_TIMEOUT = "subscribe_timeout"
# Venue spellings in use: equities (BRK.B, ^GSPC, ES=F), ccxt unified
# (BTC/USDT:USDT) and native ids (BTCUSDT, tBTCUSD, BTC-PERP). The charset is
# closed on purpose: anything else never reaches a session key or a path.
_SYMBOL_RE = re.compile(r"[A-Za-z0-9^][A-Za-z0-9._\-/:=^+]{0,63}")


def normalize_symbol(raw: str) -> str | None:
    """Strip and validate a client ``Subscribe.symbol``; None when malformed."""
    symbol = raw.strip()
    return symbol if _SYMBOL_RE.fullmatch(symbol) else None


class _SubscribeDeadlineExceeded(Exception):
    """A subscribe ran past SUBSCRIBE_DEADLINE_S (the server did not finish in time)."""


class _TokenBucket:
    """Per-connection inbound frame budget: a burst, refilled at a steady rate."""

    def __init__(self, burst: float, rate_per_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._capacity = float(burst)
        self._rate = float(rate_per_s)
        self._clock = clock
        self._tokens = float(burst)
        self._last = clock()

    def take(self) -> bool:
        now = self._clock()
        self._tokens = min(self._capacity, self._tokens + (now - self._last) * self._rate)
        self._last = now
        if self._tokens < 1.0:
            return False
        self._tokens -= 1.0
        return True


async def _accept(ws: WebSocket) -> None:
    """Complete the handshake, echoing the FlowMap subprotocol the peer offered."""
    await ws.accept(subprotocol=_env.accept_subprotocol(ws.scope.get("subprotocols") or []))


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    """Origin gate + per-process connection cap, then the normal stream.

    Both rejections must deliver an HONEST close code to the peer, which a
    bare handshake refusal (HTTP 403) cannot — so the socket is accepted and
    immediately closed with the code (1008 policy / 1013 try-again-later)
    after a plain-language Status frame. The FlowMap webview and dev server
    origins pass the built-in policy; see :func:`api._env.origin_allowed` and
    ``FLOWMAP_WS_ALLOWED_ORIGINS`` / ``FLOWMAP_WS_MAX_CONNECTIONS``.
    """
    state = ws.app.state
    if not _env.origin_allowed(ws.headers.get("origin")):
        logger.warning("ws refused: origin %r not allowed -> 1008",
                       ws.headers.get("origin"))
        await _accept(ws)
        await _reject(ws, "closed", _CLOSE_POLICY, "origin not allowed")
        return
    live = getattr(state, "ws_live_connections", 0)
    if live >= _env.ws_max_connections():
        logger.warning("ws refused: connection cap reached (%d live) -> 1013", live)
        await _accept(ws)
        await _reject(ws, "degraded", _CLOSE_TRY_AGAIN_LATER,
                      "connection cap reached; try again later")
        return
    # Single event loop: the increment/decrement never span an await, so the
    # plain attribute is race-free. (Per-app == per-process in production.)
    state.ws_live_connections = live + 1
    try:
        await _accept(ws)
        await _Connection(ws, state.manager).run()
    finally:
        state.ws_live_connections = getattr(state, "ws_live_connections", 1) - 1


async def _reject(ws: WebSocket, feed_state: events.FeedState, code: int, reason: str) -> None:
    """Accept-then-close rejection with a plain-language Status + reason."""
    status = events.Status(
        feed_state=feed_state,
        capability={"reason": reason},
        latency_ms=0.0,
        clock_skew_ms=0.0,
    )
    try:
        await ws.send_bytes(wire.encode(status))
    except Exception:  # peer may already be gone; close anyway
        pass
    try:
        await ws.close(code=code, reason=reason)
    except Exception:  # already closed by the peer or the transport
        pass


async def _settle(work: Awaitable[None]) -> None:
    """Await ``work`` to completion even while the awaiting task is cancelled.

    The work runs as its own task, so a cancellation of the caller cannot cut a
    teardown short. Cancellations that land while waiting are absorbed: the
    caller is leaving anyway and returns once the work is done. A failure inside
    the work still propagates.
    """
    task = asyncio.ensure_future(work)
    while not task.done():
        try:
            await asyncio.wait({task})
        except asyncio.CancelledError:
            continue  # absorbed on purpose: the work is not cancelled, so keep waiting
    task.result()


class _Connection:
    """Per-connection state: send queue, current session, latency estimate."""

    def __init__(
        self,
        ws: WebSocket,
        manager: SessionManager,
        *,
        clock: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        self._ws = ws
        self._manager = manager
        # Monotonic nanoseconds. Injected so liveness and RTT tests drive time
        # explicitly instead of racing the wall clock.
        self._clock = clock
        self._client = ClientTx()
        self._session: Session | None = None
        self._send_lock = asyncio.Lock()
        self._hello_sent = False
        self.latency_ms = 0.0
        # Wall-clock skew of the CLIENT clock vs ours, derived from an
        # optional Subscribe.client_ts_ns.
        # Positive = client clock ahead. 0.0 until a Subscribe carries one.
        self.clock_skew_ms = 0.0
        self._last_recv_ns = clock()
        self._history_generation = 0
        self._history_work: asyncio.Task[bytes] | None = None
        self._history_response: asyncio.Task[None] | None = None
        self._history_pending: tuple[Session, int, events.HistoryRequest] | None = None
        self._closed = False
        # True while a Subscribe is being served. The server is busy, not the
        # peer silent, so the liveness check must not fire during it.
        self._subscribing = False
        # The task serving the current Subscribe. It runs beside the receive
        # loop, so a peer close or a newer Subscribe is seen during the wait.
        self._subscribe_task: asyncio.Task[None] | None = None
        # Frames that arrive while a Subscribe is in flight, in arrival order.
        # They apply once that subscription is attached, as they would have
        # when the receive loop served the Subscribe inline.
        self._deferred: list[object] = []
        # Set when a refusal has closed the socket: the receive loop returns.
        self._stopped = asyncio.Event()
        # Ping timestamps (server_send_ns) awaiting their Pong, oldest first.
        self._outstanding_pings: dict[int, None] = {}
        self._inbound = _TokenBucket(INBOUND_BURST_FRAMES, INBOUND_FRAMES_PER_S)

    def _conn_stats(self) -> dict[str, float]:
        """Per-connection latency/skew read by the session's Status broadcasts.

        Installed on the Session as ``conn_stats`` at subscribe, unless the
        session already carries a hook of its own.
        """
        return {
            "latency_ms": round(self.latency_ms, 3),
            "clock_skew_ms": round(self.clock_skew_ms, 3),
        }

    def _record_rtt(self, latency_ms: float) -> None:
        """Feed the measured RTT into the server-stats producer when one is
        mounted on the manager (a bare manager has none)."""
        stats = getattr(self._manager, "stats", None)
        record_rtt = getattr(stats, "record_rtt", None)
        if callable(record_rtt):
            try:
                record_rtt(latency_ms)
            except Exception:  # telemetry must never kill the stream
                logger.debug("stats.record_rtt failed", exc_info=True)

    def _count_rejected(self) -> None:
        """Count THIS layer's refusal in the server-stats aggregate.

        ``SessionManager.subscribe`` already counts the refusals it raises
        (session limit, replay unavailable/stale, invalid symbol); the
        no-feed-for-market ``NotImplementedError`` is raised by the feed
        factory on a path the manager does not wrap, so unknown-market
        refusals never reached ``sessions.rejected``. Counted
        here, guarded like every other stats call."""
        stats = getattr(self._manager, "stats", None)
        inc = getattr(stats, "inc_rejected", None)
        if callable(inc):
            try:
                inc()
            except Exception:  # telemetry must never kill the stream
                logger.debug("stats.inc_rejected failed", exc_info=True)

    # -- sending ---------------------------------------------------------------

    async def _send(self, data: bytes, expected_session_id: str | None = None) -> None:
        async with self._send_lock:
            if expected_session_id is not None and (
                self._session is None or self._session.session_id != expected_session_id
            ):
                return
            await asyncio.wait_for(self._ws.send_bytes(data), SEND_TIMEOUT_S)
            # The protected snapshot starts with Hello. Enable keepalive only
            # after that first handshake frame has actually reached the peer.
            if data and data[0] == wire.MSG_HELLO:
                self._hello_sent = True

    async def _flush_loop(self) -> None:
        try:
            while True:
                session_id = getattr(self._session, "session_id", None)
                for frame in self._client.drain(FLUSH_MAX_BYTES):
                    await self._send(frame, session_id)
                await asyncio.sleep(FLUSH_INTERVAL_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            # A dead peer (send timeout / broken pipe) must not leave the
            # connection half-alive: abort so the receive loop unwinds and the
            # session is released.
            await self._abort()

    async def _ping_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(PING_INTERVAL_S)
                if (
                    not self._subscribing
                    and self._clock() - self._last_recv_ns > LIVENESS_TIMEOUT_S * 1e9
                ):
                    logger.warning("ws peer silent for %.0fs: aborting", LIVENESS_TIMEOUT_S)
                    await self._abort()
                    return
                if not self._hello_sent:
                    continue
                ping = events.Ping(server_send_ns=self._clock())
                self._note_ping(ping.server_send_ns)
                await self._send(wire.encode(ping))
        except asyncio.CancelledError:
            raise
        except Exception:
            await self._abort()

    def _note_ping(self, sent_ns: int) -> None:
        self._outstanding_pings[sent_ns] = None
        while len(self._outstanding_pings) > PING_OUTSTANDING_MAX:
            del self._outstanding_pings[next(iter(self._outstanding_pings))]

    async def _close_flood(self) -> None:
        try:
            await self._ws.close(code=_CLOSE_POLICY, reason="inbound rate limit exceeded")
        except Exception:  # already closing/closed: nothing to do
            pass

    async def _abort(self) -> None:
        """Sender-side teardown (dead peer / failed send). Closing the socket
        unwinds the receive loop; ``run``'s finally releases the session."""
        try:
            await self._ws.close()
        except Exception:  # already closing/closed: nothing to do
            pass

    # -- lifecycle -------------------------------------------------------------

    async def run(self) -> None:
        """Serve the socket until it closes, then release everything it holds.

        Returns normally on every end: a peer close, a refusal, or the endpoint
        being cancelled while the socket is open (the server stopping it). The
        release always runs to completion, so the session is never left attached
        by an interrupted teardown, and the endpoint never ends with a
        CancelledError that the transport has to re-raise.
        """
        tasks = (
            asyncio.create_task(self._flush_loop(), name="ws-flush"),
            asyncio.create_task(self._ping_loop(), name="ws-ping"),
        )
        try:
            await self._receive_loop()
        except WebSocketDisconnect:
            pass  # the peer closed the socket: the normal end of the loop
        except asyncio.CancelledError:
            logger.debug("ws endpoint cancelled: releasing the connection")
        finally:
            await _settle(self._release(tasks))

    async def _release(self, tasks: tuple[asyncio.Task[None], ...]) -> None:
        self._closed = True
        self._invalidate_history()
        for t in tasks:
            t.cancel()
        # Retrieve cancellations AND any send-vs-close race the loops
        # lost after our close(): swallowed here, never leaked.
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await self._cancel_subscribe()
        finally:
            await self._drop_session()

    async def _cancel_subscribe(self) -> None:
        """Stop the in-flight Subscribe, if any, and forget its deferred frames.

        A subscribe cancelled here either never attached, or it attached a
        session that the following ``_drop_session`` releases.
        """
        task, self._subscribe_task = self._subscribe_task, None
        self._deferred.clear()
        if task is not None and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        # A task cancelled before its first step never runs its finally, so the
        # flag is cleared here as well as there.
        self._subscribing = False

    async def _receive_loop(self) -> None:
        stopped = asyncio.ensure_future(self._stopped.wait())
        try:
            await self._read_messages(stopped)
        finally:
            stopped.cancel()

    async def _read_messages(self, stopped: asyncio.Future) -> None:
        while True:
            message = await self._next_message(stopped)
            if message is None:  # a refused subscribe closed the connection
                return
            if message["type"] == "websocket.disconnect":
                return
            self._last_recv_ns = self._clock()
            if not await self._charge_inbound():
                return
            data = message.get("bytes")
            if data is None:  # text frame on a binary-only protocol
                # Robustness, not protocol enforcement: log and keep reading.
                # The FlowMap client never sends text; a stray text frame is
                # a broken intermediary, not a peer worth killing the stream
                # for. (Any bytes present still count as liveness above.)
                logger.warning(
                    "text WS frame on binary protocol: frame dropped, connection kept"
                )
                continue
            if not await self._handle_frame(data):
                return

    async def _next_message(self, stopped: asyncio.Future) -> MutableMapping[str, Any] | None:
        """The next inbound message, or None once a refusal has stopped the loop."""
        receive = asyncio.ensure_future(self._ws.receive())
        try:
            await asyncio.wait({receive, stopped}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not receive.done():
                receive.cancel()
        if receive.done() and not receive.cancelled():
            return receive.result()
        return None

    async def _drop_session(self) -> None:
        self._invalidate_history()
        if self._session is not None:
            await self._manager.unsubscribe(self._session, self._client)
            self._session = None

    def _invalidate_history(self) -> None:
        """Cancel delivery immediately, let an already-running disk worker drain.

        Cancelling to_thread does not stop its thread. Shield the core operation
        so its overview lock remains held until aggregation really finishes;
        another zoom must not launch concurrent workers against that cache.
        """
        self._history_generation += 1
        self._history_pending = None
        response, self._history_response = self._history_response, None
        if response is not None:
            response.cancel()
        if self._history_work is not None:
            self._drain_history(self._history_work)

    def _queue_history(self, req: events.HistoryRequest) -> None:
        session = self._session
        if session is None or self._closed:
            return
        pending = session, self._history_generation, req
        if self._history_work is not None:
            # One active worker and one coalesced pending request per socket.
            # Native and overview loaders may overlap; hostile request bursts
            # cannot create an unbounded queue of multi-MiB disk operations.
            self._history_pending = pending
            return
        self._start_history(*pending)

    def _start_history(self, session: Session, generation: int, req: events.HistoryRequest) -> None:
        if self._closed or session is not self._session or generation != self._history_generation:
            return
        work = asyncio.create_task(session.handle_history_async(req), name="ws-history-work")
        self._history_work = work
        self._history_response = asyncio.create_task(
            self._deliver_history(work, session, generation, getattr(session, "session_id", None)), name="ws-history-response",
        )
        work.add_done_callback(self._history_done)

    def _history_done(self, work: asyncio.Task[bytes]) -> None:
        # Retrieve failures even if subscription replacement cancelled delivery.
        if not work.cancelled():
            work.exception()
        self._drain_history(work)

    def _drain_history(self, work: asyncio.Task[bytes]) -> None:
        if work is not self._history_work or not work.done() or self._history_response is not None:
            return
        self._history_work = None
        pending, self._history_pending = self._history_pending, None
        if pending is not None:
            self._start_history(*pending)

    async def _deliver_history(self, work: asyncio.Task[bytes], session: Session, generation: int,
                               session_id: str | None = None) -> None:
        try:
            frame = await asyncio.shield(work)
            async with self._send_lock:
                # Check AFTER acquiring the send lock: a new Hello can have
                # replaced the subscription while this response waited to send.
                if (self._closed or session is not self._session or generation != self._history_generation
                    or (session_id is not None and session.session_id != session_id)):
                    return
                await asyncio.wait_for(self._ws.send_bytes(frame), SEND_TIMEOUT_S)
        except asyncio.CancelledError:
            return  # torn down while the reply was pending: nothing left to deliver
        except Exception:
            logger.warning("history response failed; connection kept", exc_info=True)
        finally:
            if self._history_response is asyncio.current_task():
                self._history_response = None
            self._drain_history(work)

    # -- dispatch --------------------------------------------------------------

    async def _charge_inbound(self) -> bool:
        """Spend one inbound token; on a flood, close with 1008 and return False."""
        if self._inbound.take():
            return True
        logger.warning(
            "ws inbound flood (burst %d, sustained %.0f frames/s): closing with 1008",
            INBOUND_BURST_FRAMES,
            INBOUND_FRAMES_PER_S,
        )
        await self._close_flood()
        return False

    async def _handle_frame(self, data: bytes) -> bool:
        """Dispatch every message batched in one frame; False = closed.

        Malformed input is LOGGED, not fatal: the offset is unrecoverable
        mid-frame, so the remainder of THIS frame is dropped and the loop
        resyncs on the next frame boundary. The connection stays up — a
        single corrupt frame (or a hostile burst) must not take a healthy
        subscription down.

        The frame already cost one token in the receive loop. Each further
        message in it costs one more, so a batch cannot carry more work than
        the same messages sent as separate frames. Consecutive Subscribe
        messages coalesce: each one replaces the subscription before it, so
        only the last of a run is dispatched.
        """
        offset = 0
        decoded = 0
        held: events.Subscribe | None = None  # a Subscribe awaiting its successor
        while offset < len(data):
            try:
                ev, offset = wire.decode(data, offset)
            except (ValueError, RecursionError) as exc:
                # A deeply nested envelope exhausts the recursion limit rather
                # than raising ValueError. It is still malformed input, and it
                # must not escape and tear the connection down.
                logger.warning(
                    "malformed client frame (%r): dropping the rest of the "
                    "frame, connection kept",
                    exc,
                )
                break
            if ev is None:
                continue  # unknown msg_type: skipped via payload_len
            decoded += 1
            if decoded > 1 and not await self._charge_inbound():
                return False
            if isinstance(ev, events.Subscribe):
                if held is not None:
                    logger.debug("subscribe superseded inside one frame: dropped")
                held = ev
                continue
            if held is not None:
                pending, held = held, None
                if not await self._dispatch_message(pending):
                    return False
            if not await self._dispatch_message(ev):
                return False
        if held is not None:
            return await self._dispatch_message(held)
        return True

    async def _dispatch_message(self, ev: object) -> bool:
        """Dispatch one decoded message; False = the connection is closed."""
        try:
            return await self._dispatch(ev)
        except Exception:  # one bad message never kills the loop
            logger.warning(
                "dispatch error on %s: message dropped, connection kept",
                type(ev).__name__,
                exc_info=True,
            )
            return True

    async def _dispatch(self, ev: object) -> bool:
        if isinstance(ev, events.Subscribe):
            # A newer Subscribe supersedes one still in flight.
            await self._cancel_subscribe()
            self._subscribing = True
            self._subscribe_task = asyncio.create_task(self._run_subscribe(ev), name="ws-subscribe")
            return True
        if isinstance(ev, events.Unsubscribe):
            await self._cancel_subscribe()
            await self._drop_session()
            return True
        if self._subscribing and not isinstance(ev, events.Pong):
            # Applies to the subscription being set up, once it is attached.
            # Keepalive replies are never held back: they measure the peer.
            if len(self._deferred) < INBOUND_BURST_FRAMES:
                self._deferred.append(ev)
            else:
                logger.warning("ws frames queued behind a subscribe exceed %d: dropped",
                               INBOUND_BURST_FRAMES)
            return True
        self._apply(ev)
        return True

    async def _run_subscribe(self, sub: events.Subscribe) -> None:
        """Serve one Subscribe, then apply the frames that queued behind it."""
        try:
            accepted = await self._subscribe(sub)
        finally:
            self._subscribing = False
            # The peer's silence clock restarts from when the server could
            # actually read again.
            self._last_recv_ns = self._clock()
        if not accepted:
            self._deferred.clear()
            self._stopped.set()
            return
        deferred, self._deferred = self._deferred, []
        for ev in deferred:
            self._apply(ev)

    def _apply(self, ev: object) -> None:
        """Apply one settled message, in arrival order."""
        if isinstance(ev, events.HistoryRequest):
            if self._session is None:
                logger.debug("HistoryRequest before Subscribe: ignored")
            else:
                # Keep receiving Pong/Subscribe while the disk worker runs.
                # Its pre-encoded response bypasses live lag-drop accounting.
                self._queue_history(ev)
        elif isinstance(ev, events.Pong):
            # Only an echo of a ping this connection actually sent measures
            # anything. echo_ns is client-supplied, and an unchecked value
            # would feed arbitrary numbers into latency_ms, Status and /api/health.
            if ev.echo_ns not in self._outstanding_pings:
                logger.debug("pong for an unknown ping ignored")
                return
            del self._outstanding_pings[ev.echo_ns]
            rtt_ns = self._clock() - ev.echo_ns
            if not 0 <= rtt_ns <= PONG_RTT_MAX_NS:
                return
            self.latency_ms = rtt_ns / 2 / 1e6
            self._record_rtt(self.latency_ms)
            logger.debug("pong: rtt=%.2f ms", rtt_ns / 1e6)
        else:
            # Replay transport controls: forwarded to the session's feed (the
            # recording-backed ReplayFeed consumes them; live feeds ignore).
            if self._session is None:
                logger.debug("%s before Subscribe: ignored", type(ev).__name__)
            else:
                if isinstance(ev, events.Seek):
                    self._invalidate_history()
                self._session.feed_control(ev)

    async def _subscribe(self, sub: events.Subscribe) -> bool:
        # A second Subscribe on the same connection replaces the first: the
        # detach happens BEFORE the new subscribe so an over-limit refusal
        # cannot leave the client attached to two sessions.
        await self._drop_session()
        # Re-subscribe hygiene: frames still queued by
        # the OLD subscription belong to another symbol/session and must
        # never flush after the new Hello/snapshot. The session is detached
        # above (it can offer nothing more), so this drain is exact. It is a
        # purely synchronous loop — no await between the length check and the
        # drain — so the concurrent flush loop cannot interleave mid-drain.
        while len(self._client):
            self._client.drain(FLUSH_MAX_BYTES)
        # The symbol is client text and joins the SessionManager key: refuse a
        # malformed one here, before it can mint a Session. A valid one is
        # stripped of surrounding whitespace so "BTCUSDT " and "BTCUSDT" share
        # one session.
        symbol = normalize_symbol(sub.symbol)
        if symbol is None:
            logger.warning(
                "refused subscribe: malformed symbol %r (%r) -> 1003",
                sub.symbol, sub.market,
            )
            await self._refuse("degraded", _CLOSE_UNSUPPORTED, reason=REASON_INVALID_SYMBOL)
            return False
        if symbol != sub.symbol:
            sub = msgspec.structs.replace(sub, symbol=symbol)
        # Optional client wall-clock stamp: derive the
        # clock skew for THIS subscription. Absent (old client) -> 0.0.
        client_ts_ns = getattr(sub, "client_ts_ns", None)
        if client_ts_ns is not None:
            self.clock_skew_ms = (int(client_ts_ns) - time.time_ns()) / 1e6
        else:
            self.clock_skew_ms = 0.0
        try:
            session = await self._subscribe_with_progress(sub)
        except SessionLimitError:
            logger.warning(
                "refused subscribe: session limit reached (%r:%r mode=%r) -> 1013",
                sub.market, sub.symbol, sub.mode,
            )
            await self._refuse("degraded", _CLOSE_TRY_AGAIN_LATER)
            return False
        except ReplayUnavailableError as exc:
            # Honest refusal (NOT a live feed under a replay label): the client
            # hides its Replay toggle unless a server advertises the capability.
            logger.warning(
                "refused subscribe: no replayable recording (%r:%r: %r) -> 1003",
                sub.market, sub.symbol, exc,
            )
            await self._refuse("degraded", _CLOSE_UNSUPPORTED)
            return False
        except ValueError as exc:
            # A ValueError is bad input or config in general (e.g. a recording-
            # path-unsafe name, record._safe_component), not always the symbol.
            # Only a symbol the provider says does not exist
            # (feeds._yahoo.UnknownSymbolError, a ValueError subclass) is named
            # as such: a retry cannot cure it, so the client parks on
            # reason=invalid_symbol instead of reconnecting. Any other
            # ValueError keeps the unreasoned refusal it always had. The refusal
            # contract is a Status frame + close, never a silent no-op. A crypto
            # venue's table that does not list the symbol is the same answer.
            unknown = (UnknownSymbolError, UnlistedSymbolError)
            reason = REASON_INVALID_SYMBOL if isinstance(exc, unknown) else None
            logger.warning(
                "refused subscribe: rejected input (%r:%r: %r) -> 1003",
                sub.market, sub.symbol, exc,
            )
            await self._refuse("degraded", _CLOSE_UNSUPPORTED, reason=reason)
            return False
        except NotImplementedError as exc:
            # No feed for this market (feeds.router). Counted here because
            # the core-side refusal counter does not wrap the feed factory.
            self._count_rejected()
            logger.warning(
                "refused subscribe: no feed for market (%r:%r: %r) -> 1003",
                sub.market, sub.symbol, exc,
            )
            await self._refuse("closed", _CLOSE_UNSUPPORTED)
            return False
        except _SubscribeDeadlineExceeded:
            logger.error(
                "subscribe did not finish within %.0fs (%r:%r) -> 1011",
                SUBSCRIBE_DEADLINE_S, sub.market, sub.symbol,
            )
            await self._refuse("degraded", _CLOSE_INTERNAL, reason=REASON_SUBSCRIBE_TIMEOUT)
            return False
        except Exception:  # every failure must reach the client as a refusal
            # Feed construction, boot or I/O failures used to escape here: the
            # socket stayed open with no session and no Status, and the client
            # waited forever. Refuse honestly instead.
            logger.exception(
                "subscribe failed (%r:%r) -> 1011", sub.market, sub.symbol,
            )
            await self._refuse("degraded", _CLOSE_INTERNAL)
            return False
        # Expose this connection's measured latency/skew to the session's
        # Status broadcasts. A hook the session already carries wins.
        if session.conn_stats is None:
            session.conn_stats = self._conn_stats
        return True

    async def _subscribe_with_progress(self, sub: events.Subscribe) -> Session:
        """Run the manager subscribe under the deadline, keeping the handshake alive.

        The attached session is recorded on the connection straight after the
        manager returns, before the progress task is awaited. A cancel that lands
        during that await then still finds the subscription and releases it.
        """
        progress = asyncio.create_task(self._subscribe_progress(), name="ws-subscribe-progress")
        deadline = asyncio.timeout(SUBSCRIBE_DEADLINE_S)
        try:
            async with deadline:
                session = await self._manager.subscribe(sub, self._client)
            self._session = session
            return session
        except TimeoutError:
            if deadline.expired():
                raise _SubscribeDeadlineExceeded() from None
            raise
        finally:
            progress.cancel()
            await asyncio.gather(progress, return_exceptions=True)

    async def _subscribe_progress(self) -> None:
        """Send a pre-Hello Status every ``SUBSCRIBE_PROGRESS_S`` while preparing.

        A cold subscribe can spend many seconds in venue discovery before the
        session can send its Hello. The client's handshake deadline is shorter
        than that, and only a Status before the Hello extends it, so a healthy
        subscribe would otherwise be torn down and retried.
        """
        try:
            while True:
                await asyncio.sleep(SUBSCRIBE_PROGRESS_S)
                await self._send(wire.encode(events.Status(
                    feed_state="reconnecting",
                    capability={},
                    latency_ms=round(self.latency_ms, 3),
                    clock_skew_ms=round(self.clock_skew_ms, 3),
                )))
        except asyncio.CancelledError:
            raise
        except Exception:  # a dead peer is torn down by the flush/ping loops
            logger.debug("subscribe progress Status not sent", exc_info=True)

    async def _refuse(self, feed_state: events.FeedState, code: int, reason: str | None = None) -> None:
        try:
            status = events.Status(
                feed_state=feed_state,
                # ``reason`` rides in capability (the client reads
                # capability.reason); an unreasoned refusal keeps capability={}.
                capability={} if reason is None else {"reason": reason},
                # Real measurements where the connection has any: a refusal
                # after live pings no longer claims 0.0.
                latency_ms=round(self.latency_ms, 3),
                clock_skew_ms=round(self.clock_skew_ms, 3),
            )
            await self._send(wire.encode(status))
        finally:
            # The close must happen even when the Status could not be sent, or
            # the peer never learns why it was refused.
            try:
                await self._ws.close(code=code)
            except Exception:  # already closing/closed
                logger.debug("ws close after refusal failed", exc_info=True)
