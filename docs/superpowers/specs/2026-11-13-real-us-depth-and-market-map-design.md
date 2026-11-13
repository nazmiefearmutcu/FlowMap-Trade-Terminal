# Real US equity depth, honest history, cursor readout and the market map

Date: 2026-11-13. Status: design approved by the owner in chat; this file is the
written form.

## Why

Four complaints from the owner, on the installed 1.6.2:

1. US equities draw a "fake heatmap". The keyless tier builds depth, a DOM and a
   Bid/Ask/Spread from the volume of Yahoo one-minute bars. It is labelled SYNTH,
   and it is still invented.
2. History does not load. With "history depth" at 1 h, opening ETH shows a few
   seconds of data.
3. The cursor shows no price and no date/time on the axes, and the readout box
   uses abbreviations (`PX`, `GRP`, `AVG`) that mean nothing to a trader.
4. There is no market-wide map. The owner wants a tile ("kutucuk") map for US
   stocks and for crypto, one click away in the top bar.

## Principles

- Nothing is drawn that was not observed. Where no depth is known, none is drawn.
- Everything is free and keyless.
- Every source is named in the interface, with its limits.

## Part A1: history that loads, without invented depth

**Root cause.** `Session._run_backfill` returns early when the grid is banded
(`cfg.band_up`/`band_down` set). The client default price band is `deep`, which is
banded, so a cold subscribe gets no history at all. On the `native` band the
backfill does run, and paints a volume-at-price *reconstruction* as if it were
depth.

**Design.** History before the app was watching is price history: OHLC, volume
and, for crypto, the taker buy/sell split. It carries no depth, on every band.

- `_run_backfill` no longer converts candles into density columns. It walks the
  candles oldest first and, for each one, advances the live grid with an empty
  book anchored at the candle close (`BookState(..., anchor_px=close)`, through
  `Session._on_book`) and then feeds `Grid.on_bar_sample`. This is the path the
  keyless equity warmup already uses, and it works on banded grids.
- Columns are time-true: one column per `dt_ns`, so one hour of crypto history at
  250 ms is 14 400 columns. The span is the newest candles that fit in three
  quarters of the ring (`ring_columns * 3 // 4` columns), at most
  `backfill_max_cols` candles. The loop yields to the event loop every few
  candles.
- `Grid.on_bar_sample` gains optional `buy_volume` / `sell_volume`. When both are
  given they add to `vol_buy`, `vol_sell` and `cvd_cum`, so crypto history has
  volume bars and CVD.
- A keyless equity feed is skipped here: its own warmup already supplies price
  history. Keyed equity tiers use this path.
- The reconstructed-density converter (`columns_from_candles` and its helpers),
  its tests, and the `backfill_stretch` / backfill shape settings are removed. The
  session no longer reports `history: 'reconstructed'` for new sessions. Client
  code that renders that flag stays, for recordings and older servers.
- The `gap` marker between history and live says "price history ends, live
  resumes".

Limit, unchanged: the ring holds `ring_columns` columns (2.3 h at 250 ms), so the
`4h`, `1d` and `max` history depths still reach further back only where a
recording exists.

## Part A2: cursor readout to the standard of a trading terminal

- A small store (`client/src/ui/crosshairStore.ts`) holds the probe under the
  pointer: canvas x/y, price, price decimals, time, and whether the clock is
  session-relative. `Crosshair` writes it; it is cleared when the pointer leaves.
- `PriceAxis` draws a price tag at the pointer's y, in the axis gutter, at the end
  of the horizontal line. `TimeAxis` draws a date-and-time tag at the pointer's x,
  at the end of the vertical line: weekday, day, month, `HH:MM:SS`, in the active
  time-zone preference and locale (for example `Cum 13 Kas 20:45:18`). A
  session-relative (sim) clock shows `T+` time and no date.
- The readout box uses words: Time, Price, Bid orders, Ask orders. The grouped
  band reads "Price band 156.75–156.79 (4 levels)" and the time average reads
  "Averaged over 64.0 s". Bid/Ask rows are omitted when the instrument has no
  depth at all (capability depth `N/A`), and read "none" for an empty cell.
- Tags and box take colours from theme tokens and follow the Pixel style.

## Part A3: real displayed depth for US equities

**Source.** Cboe's public book viewer serves, for each of its four US equity
exchanges (BZX, BYX, EDGX, EDGA), the top five displayed levels per side and the
last ten prints of a symbol, as JSON, keyless. The page reloads every 5 s.

**What it is not.** It is not the consolidated book. NYSE, Nasdaq and the other
venues are absent, and each side stops at five levels per exchange. The interface
says so wherever the depth tier is shown.

**Server** (keyless tier of `EquityFeed`):

- `feeds/equity_book.py`: parsing, the per-price merge, print alignment between
  reads, and the HTTP client. Pure apart from the client.
- Every `dt_equity_book_ns` (5 s; never below 2 s) the four books are read
  together and merged by price, sizes in shares. A book that misses a read keeps
  its last one for three cycles. After three cycles with no book at all the depth
  is withheld, a `gap` marker says so, and the feed reports `degraded`.
- New prints become trades stamped with the venue clock and tagged with the venue
  (`EDGX`, `BZX`, ...). They carry no aggressor side: `trade_side` and `cvd` stay
  `na`. The tape is a sample (`tape: 'poll'`).
- A symbol with no Cboe print for `dt_equity_keyless_ns` polls a last price so the
  chart still moves; that tick has size 0 and venue `last-price`.
- Capability: `depth: 'L2-snapshot'`, `depth_scope: 'cboe-top5'`. The grid runs in
  `MODE_L2` at the keyless column cadence.
- Trading window: the feed is live from 04:00 to 20:00 New York time on trading
  days (pre-market, regular session, after-hours), not only the regular session.
- Warmup: the last session's Yahoo one-minute bars as price history, on empty
  anchored books. No synthetic profile. `equity_profile.py` is removed.
- A recorded tail made under another depth tier is never continued (a synthetic
  recording must not become live depth): the session starts cold.
- Old recordings still replay, labelled SYNTH, as recorded.

**Client.** The existing `L2-SNAPSHOT` tier renders it. Where the tier is shown
for an equity (top bar chip title, heat legend, DOM header, symbol search), the
scope reads "Cboe exchanges only: top 5 levels per side on BZX, BYX, EDGX, EDGA".
Texts that describe equity as synthetic are updated (README, user guide, closed
banner, i18n).

## Part B: the market map

**Access.** A "Map" button in the top bar opens a full-window screen with two
tabs, "US stocks" and "Crypto". `Esc` closes it.

**Server.** `GET /api/market-map?market=us|crypto` returns
`{market, asOf, source, stale, items}`; each item is
`{symbol, name, group, marketCap, price, change, volume, chart}` where `change`
maps a period to a percentage and `chart` is `{market, symbol}` or null.

- US: Nasdaq's public screener (one request for every listed stock). The top 500
  by market capitalisation, grouped by the screener's sector. `change` has `1d`.
  `chart` is `equity:<SYMBOL>`.
- Crypto: CoinGecko `coins/markets`. The top 100 by market capitalisation after
  removing stablecoins and wrapped or staked duplicates (a short bundled list).
  `change` has `1h`, `24h`, `7d`. `chart` points at the Binance spot pair when the
  app's symbol directory knows it, else null.
- Each market is cached for 60 s. When a refresh fails the last good answer is
  served with `stale: true`; with no answer yet the endpoint returns 503 with a
  reason.

**Client.** `client/src/ui/marketMap/`:

- `treemap.ts`: a squarified treemap layout, pure, two levels (groups, then
  tiles), no new dependency.
- `MarketMap.tsx`: tabs, the period switch (crypto), the legend, the source and
  "as of" line, the stale notice, loading and error states with a retry.
- Tile area is market capitalisation. Colour runs from the theme's down colour
  through neutral to its up colour, clamped at ±3% (1 d stocks), ±2% (1 h), ±10%
  (24 h) and ±20% (7 d). Tiles show the symbol and the change when they are large
  enough.
- Hover or focus shows name, price, change, market cap and volume. A click or
  Enter opens that instrument's chart and closes the map; a tile with no chart is
  not a button.
- Every theme and the Pixel style are supported from tokens only. English and
  Turkish.

## Testing

- Server: unit tests for the Cboe parser, merge and print alignment; feed tests
  with injected books, bars and clocks; session tests for anchored empty books,
  the tier-mismatch cold start and the price-history backfill on a banded grid;
  market-map parser and cache tests from recorded fixtures. No test touches the
  network.
- Client: unit tests for the treemap layout, the map screen, the crosshair store
  and both axis tags; existing suites stay green.
- Live: NVDA and ETH checked in the running app, light and dark theme, Normal and
  Pixel style, and a narrow window for the top bar.

## Out of scope

- Aggressor side and CVD for equities.
- A consolidated US book, or any paid or keyed source.
- Map filters, search, custom universes, or index membership.
