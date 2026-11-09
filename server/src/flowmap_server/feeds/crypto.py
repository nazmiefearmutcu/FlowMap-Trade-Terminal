"""Crocodile live bridge: crypto venue streams -> canonical FeedEvents.

:class:`CryptoFeed` implements the :class:`~flowmap_server.feeds.base.Feed`
protocol on top of a Crocodile connector. The moving parts:

- A :class:`~crocodile.core.connector.Connector` (built via ``make_connector``)
  + :class:`~crocodile.core.ingest.transport.AiohttpWsTransport` runs the
  supervised ws loop (``Connector.run`` reconnects internally with backoff;
  Binance depth streams are sequence-gated through ``OrderBookSync`` +
  ``BookResyncBridge``, so only in-order deltas and resync snapshots ever
  reach the sink).

  Five of the streamable venues have hand-written connectors (binance, bybit,
  coinbase, deribit, okx); every other ccxt venue id falls through to the
  universal ccxt connector, which re-reads the whole book each tick instead of
  streaming diffs. That difference is carried honestly in
  ``capability["depth"]`` (``L2`` vs ``L2-snapshot``) rather than hidden — see
  :attr:`CryptoFeed.native`. The engine has ten hand-written connectors in
  total: these five streamable ones plus five that are not order-flow readers at
  all (see ``NOT_STREAMABLE``).
- :class:`_BridgeSink` — the testable translation seam (defined in
  :mod:`~flowmap_server.feeds.crypto_sink`) — receives Crocodile
  records, maintains the live L2 book, and emits canonical events:

  ============================  =======================================
  Crocodile record              canonical event
  ============================  =======================================
  ``BookSnapshot``              book replace -> full ``BookState``
                                (on a delta venue, plus ``Marker{kind=gap}``
                                first when the book was already initialized:
                                a snapshot on a live book IS the resync
                                signature. On a snapshot-driven venue it is
                                simply the next update — no marker.)
  ``BookDelta``                 level apply -> full ``BookState``
  ``Trade``                     ``Trade`` (venue-published side ->
                                ``side_src=SIDE_SRC_EXCHANGE``; a record whose
                                side the venue omitted stays ``SIDE_UNKNOWN``
                                and is marked ``SIDE_SRC_NA``, never laundered
                                into an exchange-true claim)
  ``BookTicker``                ``BBO``
  ``Liquidation``               ``Marker{kind=liquidation}``
  anything else                 ignored (not in the canonical dialect)
  ============================  =======================================

Book maintenance note (the engine's ``OrderBook`` is deliberately not used):
``OrderBook._check_gap`` re-runs sequence-continuity rules that *spuriously*
fire on the first delta after every Binance snapshot — the exchange contract
is snapshot OVERLAP (first event has ``U <= sid <= u``; ``pu``/``seq``
need not chain from the snapshot id), and post-resync kept deltas bypass the
sync machine entirely. Upstream ``OrderBookSync`` + ``BookResyncBridge`` is
the single sequencing authority, so the sink applies levels with the same
canonical semantics (amount==0 removes, snapshot replaces — mirroring
``OrderBook._apply_levels``) WITHOUT re-checking continuity.

No throttling here: every book change emits a full BookState (top
``BOOK_TOP_N`` levels per side, best-first numpy arrays). Session/Grid own
cadence via time-weighted column integration.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import math
import uuid
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Any, cast

from crocodile.core.connector import Connector
from crocodile.core.config import Settings
from crocodile.core.errors import ConfigError
from crocodile.core.ingest.transport import Transport
from crocodile.core.sink.base import Sink
from crocodile.crypto.exchanges.factory import (
    list_all_exchanges,
    list_exchanges,
    make_connector,
)
from crocodile.crypto.instruments.registry import InstrumentRegistry

from flowmap_server.config import Config
from flowmap_server.feeds.base import (
    BoundedFeedQueue,
    DropCounters,
    FeedEvent,
)
from flowmap_server.feeds.crypto_sink import BOOK_TOP_N, _BridgeSink, _PolledCCXTConnector

__all__ = [
    "BOOK_TOP_N",
    "CRYPTO_EXCHANGES",
    "NATIVE_EXCHANGES",
    "NOT_STREAMABLE",
    "CryptoFeed",
    "is_crypto_market",
    "resolve_symbol_cached",
    "split_market",
]

logger = logging.getLogger(__name__)

# Subscribe.market strings routed to CryptoFeed by the session feed factory:
# "<exchange>-<segment>" (segment forwarded to the connector, e.g. Binance spot
# vs USD-M futures ws endpoints) or bare "<exchange>".
#
# The venue set is not a hand-kept shortlist. `list_all_exchanges()` is
# the union of the engine's hand-written connectors and every ccxt venue the
# installed ccxt can reach; `make_connector` falls through to the universal
# ccxt connector for anything without a native reader. Both lists are read once
# at import — ccxt's venue table is a module constant, not a network call.

# Reachable, but NOT an order-flow view. CoinGecko publishes one 24 h candle
# per coin and the on-chain readers surface pool events — neither has a book or
# a tick tape. Subscribing to them would hand the client a `depth: "L2"` promise
# nothing can keep, so they are excluded from the venue set itself rather than
# merely hidden in the picker: one exclusion, enforced at the routing boundary,
# and every consumer (router, backfill dispatch, quote routing, discovery)
# inherits it.
NOT_STREAMABLE = frozenset({"coingecko", "base_onchain", "gmx_synthetix", "superchain", "derive"})

NATIVE_EXCHANGES = frozenset(list_exchanges()) - NOT_STREAMABLE
CRYPTO_EXCHANGES = frozenset(list_all_exchanges()) - NOT_STREAMABLE

# No ccxt or native exchange id contains "-", so "<exchange>-<segment>" parses
# unambiguously with a single partition. (Underscores are used instead:
# base_onchain, gmx_synthetix.) Asserted by tests/feeds/test_crypto_bridge.py.

# The constructor kwarg each native venue uses to pick its market segment, and
# the segments it accepts. Only these two venues take one: everywhere else the
# segment lives in the symbol (OKX "BTC-USDT-SWAP", Deribit "BTC-PERPETUAL",
# ccxt "BTC/USDC:USDC").
#
# The allowed-set is load-bearing, not decorative. Segments form a closed set:
# `<exchange>-<anything>` would pass validation on the exchange alone, so a
# caller could mint unbounded distinct market strings — each one a fresh session
# key, a fresh cache entry, a fresh directory under the recording root, and an
# outbound request to the venue. A venue that cannot use a listed segment rejects
# it instead of silently dropping it (which would have shown the client a
# `bitget-swap` label over spot data).
_SEGMENT_KWARG: dict[str, str] = {"binance": "market", "bybit": "category"}
SEGMENTS: dict[str, frozenset[str]] = {
    "binance": frozenset({"spot", "usdm", "coinm"}),
    "bybit": frozenset({"spot", "linear", "inverse", "option"}),
}

# Venue/segment pairs whose forced-liquidation topic this build can ACTUALLY
# subscribe. Not "which venues have liquidations" but which channel names the
# engine's connector sends that the venue accepts today. Measured against the
# live public sockets rather than read off the venue docs:
#
#   binance usdm  `btcusdt@forceOrder`          -> accepted
#   okx           `liq-orders` + instId         -> ERROR "channel ... doesn't exist"
#                 (OKX v5 wants `liquidation-orders` keyed by instType)
#   bybit linear  `liquidation.BTCUSDT`         -> ERROR "handler not found"
#                 (Bybit v5 renamed it `allLiquidation.{sym}`)
#
# So OKX and Bybit are deliberately absent: subscribing there would spend a
# topic slot on a channel the venue rejects AND advertise a `liquidation` marker
# that could never fire. Both are channel-name mismatches in the engine's
# connector: re-measure and add them back once the engine names the topic the
# way the venue does.
_LIQUIDATION: dict[str, frozenset[str]] = {
    "binance": frozenset({"usdm", "coinm"}),
}

# Venues that deliver liquidations WITHOUT a dedicated channel: Deribit flags
# them on the ordinary `trades` stream, which we already subscribe, and the
# engine yields a `Liquidation` record for each. Declaring the marker here keeps
# the capability honest in the other direction: under-promising misleads the
# client just as over-promising does.
_LIQUIDATION_VIA_TRADES: frozenset[str] = frozenset({"deribit"})


def split_market(market: str) -> tuple[str, str]:
    """``"binance-usdm"`` -> ``("binance", "usdm")``; ``"okx"`` -> ``("okx", "")``."""
    exchange, _, segment = market.partition("-")
    return exchange, segment


def is_crypto_market(market: str) -> bool:
    """True when *market* names a venue+segment this build can actually serve.

    Validates BOTH halves. A segment the venue has no use for is rejected rather
    than ignored — see :data:`SEGMENTS`.
    """
    exchange, segment = split_market(market)
    if exchange not in CRYPTO_EXCHANGES:
        return False
    return not segment or segment in SEGMENTS.get(exchange, frozenset())


# -- symbol translation, memoized for the server process lifetime --------
#
# `data.venues.resolve_symbol` reads the venue's ccxt market table, which that
# module keeps for its own TTL. Without this cache every feed restart and every
# kline backfill would repeat the lookup for the same unchanging symbol. Translation
# is a pure function of the venue's listing, which is stable on a session
# timescale, so the successful result is cached forever. A failed/identity result
# is NOT cached so the next call retries; a symbol the venue does not list raises
# before anything is cached.

_RESOLVED_SYMBOLS: dict[tuple[str, str], str] = {}
_PENDING_RESOLVES: dict[tuple[str, str], "asyncio.Task[str]"] = {}


async def resolve_symbol_cached(market: str, symbol: str) -> str:
    """:func:`flowmap_server.data.venues.resolve_symbol`, memoized in-process.

    Concurrent misses for the same ``(market, symbol)`` share one in-flight
    task; only a CHANGED spelling (a real translation) is cached, so a
    transient venue failure is retried on the next call instead of being
    pinned for the server lifetime.
    """
    key = (market, symbol)
    hit = _RESOLVED_SYMBOLS.get(key)
    if hit is not None:
        return hit
    task = _PENDING_RESOLVES.get(key)
    if task is None:
        task = asyncio.create_task(
            _resolve_and_cache(market, symbol),
            name=f"resolve-symbol-{market}:{symbol}",
        )
        _PENDING_RESOLVES[key] = task
    try:
        out = await task
    except BaseException:
        # A failure (or the waiter's own cancellation) must not pin the
        # in-flight slot — the next caller retries.
        if _PENDING_RESOLVES.get(key) is task:
            _PENDING_RESOLVES.pop(key, None)
        raise
    if _PENDING_RESOLVES.get(key) is task:
        _PENDING_RESOLVES.pop(key, None)
    return out


async def _resolve_and_cache(market: str, symbol: str) -> str:
    from flowmap_server.data.venues import resolve_symbol

    out = await resolve_symbol(market, symbol)
    if out != symbol:
        _RESOLVED_SYMBOLS[(market, symbol)] = out
    return out


# Book levels per side the ccxt/poll path requests (see CryptoFeed._connector_kwargs).
# Only a native connector's book is bounded by BOOK_TOP_N.
_CCXT_BOOK_DEPTH = 100


class _FeedEnd:
    """Queue sentinel: the connector task finished (exc=None -> clean end)."""

    __slots__ = ("exc",)

    def __init__(self, exc: BaseException | None) -> None:
        self.exc = exc


# What the connector task puts on the feed queue: a translated event or the end.
_CryptoItem = FeedEvent | _FeedEnd


def _harden_rest_ssl(conn: Connector) -> None:
    """Point the connector's REST path at the certifi CA bundle.

    ``AiohttpWsTransport`` already resolves certifi for the ws leg, but the
    connector's REST helper (`http_get` → lazily-created ClientSession) uses
    the interpreter's default OpenSSL trust store, which on a stock macOS
    framework Python lacks the public roots — the bootstrap/resync depth
    snapshot then fails CERTIFICATE_VERIFY_FAILED while trades stream fine.
    The wrapper pre-seeds ``conn._session`` with a certifi-backed session
    before every ``http_get`` (the run loop closes the session on each
    reconnect cycle, so a one-shot seed would not survive). No-op when
    certifi is unavailable.
    """
    import ssl

    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except (ImportError, OSError, ssl.SSLError) as exc:  # pragma: no cover
        # Keep the stock trust store: the snapshot may still fail, but the trade stream runs.
        logger.debug("crypto bridge: certifi CA bundle unavailable, using stock TLS: %s", exc)
        return

    orig_http_get = conn.http_get

    async def http_get(
        url: str,
        params: dict[str, object] | None = None,
        max_retries: int = 3,
        timeout_sec: float = 10.0,
    ) -> object:
        import aiohttp

        if conn._session is None or conn._session.closed:
            conn._session = aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=ctx))
        return await orig_http_get(
            url, params=params, max_retries=max_retries, timeout_sec=timeout_sec
        )

    # The engine declares http_get as a method; this instance-level replacement is
    # the TLS wrapper, which the static method signature does not describe.
    cast(Any, conn).http_get = http_get


class CryptoFeed:
    """Live crypto market feed (implements the Feed protocol).

    ``events()`` builds a FRESH connector + transport on every call (Feed
    restart contract: a session-layer restart after a crash or a normal end
    must reconnect and resume LIVE, never replay). While one ``events()``
    iterator is running, the engine's own supervision handles ws reconnects
    internally — the stream only ends when the connector task itself
    finishes, and a connector crash re-raises here so the session's backoff
    restart loop owns recovery. A connection producing no canonical events for
    45 seconds also unwinds through connector cleanup before that recovery.
    """

    # Crypto venues list instruments priced from cents to six figures, so the
    # sim-shaped $0.50 fallback tick is only right for the top of that range.
    # Declaring the opt-in lets the grid tick-scale to the symbol's price
    # magnitude at the first real mid (see core.grid.adaptive_tick_for); an
    # explicit FLOWMAP_CRYPTO_TICK or a ``preferred_tick`` still wins, and
    # BTC/ETH keep 0.5 (their fallback is already fine for the price).
    price_adaptive_tick = True

    def __init__(
        self,
        exchange: str,
        symbol: str,
        market: str,
        cfg: Config,
        *,
        connector_factory: Callable[[Sink], Connector] | None = None,
        transport_factory: Callable[[str], Transport] | None = None,
        stats: DropCounters | None = None,
        event_timeout_s: float = 45.0,
        engine_settings: Settings | None = None,
    ) -> None:
        if not math.isfinite(event_timeout_s) or event_timeout_s <= 0:
            raise ValueError("event_timeout_s must be finite and positive")
        self._event_timeout_s = event_timeout_s
        self._engine_settings = engine_settings or Settings.from_env()
        self.exchange = exchange
        self.symbol = symbol
        # What the connector is actually subscribed with; resolved from
        # `symbol` on the first events() call (see there). Until then the two
        # are the same, which is the common case.
        self._connector_symbol = symbol
        self.market = f"{exchange}-{market}" if market else exchange
        self._market_kw = market
        self._cfg = cfg
        self._connector_factory = connector_factory or self._default_connector
        # Recorded as a flag, NOT by comparing `self._connector_factory is
        # self._default_connector` later: every attribute access on a bound
        # method builds a NEW object, so that identity test is always False and
        # the symbol translation below would silently never run.
        self._owns_connector = connector_factory is None
        self.preferred_tick: float | None = None
        self._transport_factory = transport_factory
        self._prepared_connection: tuple[Connector, BoundedFeedQueue[_CryptoItem]] | None = None
        # Server-wide telemetry aggregate (duck-typed). Its drop
        # counters are fed at the source: queue evictions here, sink ts-gate
        # drops in the bridge sink.
        self._stats = stats
        # A venue with no hand-written reader is served by the universal ccxt
        # connector, which has no incremental book diff and no liquidation
        # topic. That is a real capability difference, so it is declared rather
        # than papered over.
        self.native = exchange in NATIVE_EXCHANGES
        # Two different things: whether to SUBSCRIBE a liquidation channel, and
        # whether liquidations can reach the client at all. Deribit flags them
        # on the trades stream we already take, so it earns the marker without
        # a channel.
        self._liquidation = market in _LIQUIDATION.get(exchange, frozenset())
        emits_liquidation = self._liquidation or exchange in _LIQUIDATION_VIA_TRADES
        # markers reflect what the client can actually receive (claiming less than
        # the venue delivers is as misleading as claiming more), and a snapshot-driven
        # venue cannot detect a sequence gap.
        markers: list[str] = ["gap"] if self.native else []
        if emits_liquidation:
            markers.insert(0, "liquidation")
        self.capability: dict[str, object] = {
            "depth": "L2" if self.native else "L2-snapshot",
            "tape": "tick",
            "trade_side": "exchange",
            # Exchange-true aggressor side -> honest per-bar CVD.
            "cvd": "exchange",
            "markers": markers,
            # The depth the book really holds: the ccxt path is requested at
            # _CCXT_BOOK_DEPTH levels, not the configured native cap.
            "book_top_n": self._cfg.book_top_n if self.native else _CCXT_BOOK_DEPTH,
            "raw_capture": self._engine_settings.raw_capture,
            "source_book_events": 0,
            "unique_book_changes": 0,
        }
        if exchange in {"bitfinex", "kraken", "dydx"}:
            self.capability.update(tape="unavailable", trade_side="unavailable", cvd="unavailable")

    async def prepare(self) -> None:
        """Resolve geometry before a grid or reconstructed history is created."""
        if self._owns_connector:
            from flowmap_server.data.venues import venue_price_tick, venue_symbols

            # A cold subscribe does two independent venue fetches before Hello:
            # the symbol translation and the venue listing that carries the tick.
            # Run them together so the wait is the slower one, not both stacked
            # (each is bounded by LIST_TIMEOUT_S). The listing is cached by the
            # time the tick lookup runs, so that lookup costs no second fetch.
            resolved, _ = await asyncio.gather(
                resolve_symbol_cached(self.market, self.symbol),
                venue_symbols(self.market),
            )
            self._connector_symbol = resolved
            self.preferred_tick = await venue_price_tick(self.market, resolved)
        if self._prepared_connection is None:
            # Constructors are network-free. The exact selected connector's
            # public mode/source metadata must exist before Session Hello.
            self._prepared_connection = self._make_connection()

    def _channels(self) -> list[str]:
        if self.exchange in {"bitfinex", "kraken", "dydx"}:
            return ["book_delta", "book_snapshot"]
        if not self.native:
            # The ccxt path answers book_delta and book_snapshot from the same
            # `fetch/watch_order_book` call, so asking for both would double the
            # venue's rate-limit spend for identical records.
            return ["trade", "book_snapshot", "book_ticker"]
        channels = ["trade", "book_delta", "book_snapshot", "book_ticker"]
        if self._liquidation:
            channels.append("liquidation")
        return channels

    def _connector_kwargs(self) -> dict[str, Any]:
        if not self.native:
            # Stream where the venue supports it; ccxt.pro falls back to REST
            # polling per channel on its own when it does not.
            return {"use_ws": True, "book_depth": _CCXT_BOOK_DEPTH}
        kwarg = _SEGMENT_KWARG.get(self.exchange)
        if kwarg is not None and self._market_kw:
            return {kwarg: self._market_kw}
        return {}

    def _default_connector(self, sink: Sink) -> Connector:
        # Binance's bare @depth stream defaults to one batch per second.
        # Request its fastest common spot/futures cadence via the public
        # subscription seam; upstream still owns resync and sequence checks.
        if not self.native:
            # Built directly, not through make_connector, so the trade polls are
            # bracketed on the sink (see _PolledCCXTConnector). make_connector's
            # universal fall-through builds the same connector otherwise, and the
            # venue id has already been checked against CRYPTO_EXCHANGES.
            conn: Connector = _PolledCCXTConnector(
                symbols=[self._connector_symbol],
                channels=self._channels(),
                out=sink,
                registry=InstrumentRegistry(),
                ccxt_id=self.exchange,
                **self._connector_kwargs(),
            )
            _harden_rest_ssl(conn)
            return conn

        from flowmap_server.feeds.binance import RealtimeBinanceConnector

        json_binance = (
            self.exchange == "binance" and self._engine_settings.binance_wire_format == "json"
        )
        factory: Callable[..., Connector] = (
            RealtimeBinanceConnector if json_binance else make_connector
        )
        args: tuple[Any, ...] = () if json_binance else (self.exchange,)
        settings_kw: dict[str, Any] = {} if json_binance else {"settings": self._engine_settings}
        conn = factory(
            *args,
            symbols=[self._connector_symbol],
            channels=self._channels(),
            out=sink,
            registry=InstrumentRegistry(),
            **settings_kw,
            **self._connector_kwargs(),
        )
        _harden_rest_ssl(conn)
        return conn

    def _make_connection(self) -> tuple[Connector, BoundedFeedQueue[_CryptoItem]]:
        # Bounded fan-in: a stalled consumer drops OLDEST events (counted
        # on the queue) instead of growing RSS without limit. The connector's
        # end sentinel is never the dropped item (see BoundedFeedQueue).
        queue: BoundedFeedQueue[_CryptoItem] = BoundedFeedQueue(
            on_drop=self._stats.inc_feed_drops if self._stats is not None else None
        )
        sink = _BridgeSink(
            queue.put_nowait,
            self._cfg.book_top_n,
            snapshot_driven=not self.native,
            stats=self._stats,
            metadata=self.capability,
        )
        conn = self._connector_factory(sink)
        self.capability.update(
            endpoint_id=getattr(conn, "capture_endpoint_id", f"{self.exchange}-public"),
            wire_format=getattr(conn, "wire_format", "json"),
            coverage=getattr(conn, "coverage", {"kind": "visible_l2"}),
        )
        return conn, queue

    async def events(self) -> AsyncIterator[FeedEvent]:
        if self._prepared_connection is None and self._owns_connector:
            # A symbol can arrive in either spelling — the venue's own
            # ("ETHBTC") or ccxt's unified ("ETH/BTC") — depending on which
            # enumerator the picker used. Translate once, here, so the same
            # user-visible symbol works whichever connector serves it. Memoized
            # for the server lifetime: a feed restart must not re-download the
            # venue's whole ccxt market table. Skipped when a factory is
            # injected: that caller owns the symbol.
            # Deliberately NOT `self.symbol`: that is the session's identity
            # (recording path, client-visible label) and must not shift under
            # a mid-session feed restart.
            self._connector_symbol = await resolve_symbol_cached(self.market, self.symbol)
        conn, queue = self._prepared_connection or self._make_connection()
        self._prepared_connection = None
        capture = None
        if self._engine_settings.raw_capture:
            from crocodile.core.capture.native import stream_context
            from crocodile.core.capture.schema import CaptureContext
            from crocodile.core.capture.writer import CaptureWriter

            try:
                budget = int(self._engine_settings.raw_capture_queue_bytes)
                if not 1 <= budget <= 32 << 20:
                    raise ValueError
            except (ValueError, TypeError):
                raise ConfigError("Raw capture queue expects 1..33554432 bytes") from None
            context = stream_context(conn, "s1")
            capture_id = uuid.uuid4().hex
            capture = await CaptureWriter.create(
                Path(self._cfg.data_dir).expanduser() / "raw-capture" / capture_id,
                CaptureContext(capture_id=capture_id, streams=(context,)),
                queue_bytes=budget,
            )
            conn.capture, conn.capture_stream_id = capture, "s1"
            self.capability.pop("capture_summary", None)
            self.capability["capture_id"] = capture_id
        try:
            if conn.transport is None and conn.ws_url:
                # Poll-only connectors (the ccxt path, CoinGecko, the on-chain
                # readers) declare an empty ws_url and drive themselves; handing
                # them a websocket transport for "" would be a connection to
                # nowhere.
                conn.transport = (
                    self._transport_factory(conn.ws_url)
                    if self._transport_factory
                    else conn.make_transport()
                )
            runner = asyncio.create_task(
                self._drive(conn, queue), name=f"crypto-feed-{self.market}:{self.symbol}"
            )
        except BaseException:
            if capture is not None:
                await capture.close()
            raise
        try:
            while True:
                try:
                    # Bound the wait directly, without creating a second task
                    # for every trade/depth update on an active market.
                    async with asyncio.timeout(self._event_timeout_s):
                        ev = await queue.get()
                except TimeoutError as exc:
                    # A transport may stay open while delivering nothing.
                    # Unwind through the existing finally block, which cancels
                    # the connector and closes its socket before Session's
                    # bounded backoff starts a fresh live connection.
                    raise TimeoutError(
                        f"no crypto feed events for {self._event_timeout_s:g}s "
                        f"({self.market}:{self.symbol})"
                    ) from exc
                if isinstance(ev, _FeedEnd):
                    # Sentinel is enqueued strictly after the connector's last
                    # record, so no translated event can be lost behind it.
                    if ev.exc is not None:
                        raise ev.exc
                    return
                yield ev
        finally:
            runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await runner
            if capture is not None:
                summary = await capture.close()
                self.capability["capture_summary"] = {
                    "capture_id": capture_id,
                    "fsynced_records": summary.stats.fsynced_records,
                    "received_frames": summary.stats.received_frames,
                    "sealed": True,
                    "peak_durable_lag_ns": summary.stats.peak_durable_lag_ns,
                    "durable_lag_overruns": summary.stats.durable_lag_overruns,
                }

    @staticmethod
    async def _drive(conn: Connector, queue: BoundedFeedQueue[_CryptoItem]) -> None:
        try:
            await conn.run()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # forwarded to the consumer
            queue.put_nowait(_FeedEnd(exc))
        else:
            queue.put_nowait(_FeedEnd(None))
