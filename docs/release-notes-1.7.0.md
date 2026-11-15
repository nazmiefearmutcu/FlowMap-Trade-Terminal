# FlowMap 1.7.0

FlowMap 1.7.0 opens the stock exchanges of the world, futures, currencies, indices and government bonds, adds an option chain, and draws official minute candles for two Eurex futures. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **World equities.** A new venue, `world`, has one market per stock exchange (`world-xist`, `world-xtai`, `world-xetr`; 131 exchanges). The symbol is the exchange's own local symbol, and the picker finds an exchange by its name ("istanbul"). What the chart shows depends on what a public source exposes for that exchange, and the badge says which: `L2-SNAPSHOT` (the publisher's own ladder, 3 to 10 levels a side, ten exchanges), `L1` (the best bid and ask with sizes, sixteen exchanges) or `SYNTH` (a volume-at-price profile from one-minute bars). Clocks read in the exchange's own time zone.
- **Futures, currencies, indices and bonds.** `futures-<venue>` (52 derivatives exchanges, for example `futures-cme_mini:ES1!`, `futures-eurex:FDAX1!`, `futures-bist:XU030D1!`), `forex:EURUSD`, `indices:SP:SPX` and `bonds:US10Y`. No public source shows resting orders for these instruments, so all of them are `SYNTH`: volume at price for a future, time at price for the others, which have no traded volume. Most futures venues are delayed.
- **A real order book where one exists.** For EUR/USD, GBP/USD, gold, silver, WTI, AAPL, TSLA, NVDA, SPY and QQQ the top bar links to another venue's instrument on the same underlying whose order book is public: Kraken's spot pairs and Binance's perpetual contracts. It is that venue's own instrument, and the link says so.
- **Option chain.** The **Options** button, or the `O` key, opens the chain of the instrument on the chart: every series and one row per strike, calls on the left and puts on the right, in three views (prices, activity, greeks). US shares, ETFs and the S&P 500, VIX and Russell 2000 indices come from Cboe's own delayed file (fifteen minutes behind) with sizes, volume and open interest; a crypto chart shows its coin's options on Bybit or Deribit; NSE and Borsa Istanbul underlyings come from the aggregator, without sizes.
- **Official Eurex minute candles.** `futures-eurex-official:FDAXZ2026` and `futures-eurex-official:FGBLZ2026` are drawn from Deutsche Börse's own delayed trade files (fifteen minutes behind): real open, high, low, close and quantity per minute, with no book, tape or trade side. Missing minutes are shown as gaps, never filled. The files are collected only while such a chart is open.
- **History on the default price band.** A keyless market used to show only its last few minutes when it opened on the default band: the session's history arrived as one burst that overran the connection's queue. It now arrives as one snapshot, and the 30-minute view is filled.

## Data sources and their terms

The new markets read public, keyless sources: TradingView's scanner, Yahoo's chart endpoint, the stock exchanges' own pages, Cboe's delayed quotes, Bybit, Deribit, Kraken, Binance and Deutsche Börse. [SECURITY.md](../SECURITY.md) lists every host and when it is contacted. Several of these are unofficial uses whose terms may not permit automated access. Deutsche Börse's free delayed data is for research use; its terms restrict commercial use.

## Known limits

- No public source shows resting orders for futures, currencies, indices or bonds, or for most exchanges outside the ten `L2-SNAPSHOT` ones.
- The Eurex official market covers two dated contracts, December 2026 DAX and Euro-Bund, and stops when they expire.
- Option chains exist for US, NSE and Borsa Istanbul underlyings and for crypto coins; none was found for European, Japanese or Hong Kong underlyings.
- The known limits of 1.6.0 still apply, including the unsigned installers. See the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
