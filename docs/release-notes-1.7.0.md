# FlowMap 1.7.0

FlowMap 1.7.0 replaces the synthetic US-equity heatmap with real order-book depth, opens the stock exchanges of the world, futures, currencies, indices and government bonds, adds an option chain and official minute candles for two Eurex futures, fills the Research drawer from free public sources, adds a market map of US stocks and coins, and loads price history on every price range. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **Real depth for US stocks.** Without any key, a US stock's heatmap, DOM ladder, bid/ask and prints come from the four Cboe US equity exchanges (BZX, BYX, EDGX, EDGA): the top five levels a side, read every five seconds, from 04:00 to 20:00 New York time. It is not the consolidated US book: NYSE and Nasdaq are not part of it, and the depth chip says so. The synthetic depth that earlier versions drew from bar volume is gone.
- **History on every price range.** The first-launch history was skipped on the default *deep* range, so a new symbol started with a few seconds of data. It now loads on every range. History is price only (price line, volume and, for crypto, CVD); no depth is drawn for the time before the app was watching.
- **Cursor readout.** The price axis and the time axis show a tag at the cursor with the price and the day and time; the readout box uses full words.
- **Market map.** The *Map* button in the top bar opens a treemap of the 500 largest US stocks by sector, or of the 100 largest coins. A tile opens its chart.
- **Macro ticker.** SOFR (New York Fed) and the 10Y–2Y spread (US Treasury) now show without a key. The high-yield spread and the stress regime need a free FRED API key (`FRED_API_KEY`).
- **Research drawer on real sources.** On a US stock: risk-factor changes and the language of earnings releases (SEC EDGAR), government contract awards (USAspending.gov), House members' trades (House Clerk reports), model gamma levels (Cboe delayed options), short-sale volume (FINRA Reg SHO) and hiring (public Greenhouse, Lever and Ashby job boards). On a coin, its own tabs: perpetual futures (Binance), options (Deribit, BTC and ETH), market data (CoinGecko, DefiLlama) and the Fear & Greed index (alternative.me). Every section says why when it has no data.
- **Markets on and off.** Settings > Markets lists every market by group with a checkbox. A market that is off is left out of the symbol search and the market map, and the app asks for none of its data; *Browse* opens the symbol search on one market.
- **SEC contact e-mail.** SEC asks automated programs to name a contact. Enter yours in Settings > Data to turn on the two SEC sections; it is kept on this computer and sent only to sec.gov.
- **Long sessions.** After a few hours open, a zoomed-out chart could go blank (no heatmap, price line, trades or axes) each time the price moved far enough for the grid to follow it, and show stale blocks where history pages met. Both are fixed: the zoomed-out history survives a grid move, and the close-up chart keeps drawing while history pages load.
- **Engine recovery.** After a crash the engine could stay down until the app was restarted: once five quick restarts failed, the app gave up. It now tries again every minute until the engine is back, and its error dialog no longer holds up those attempts. A crash inside native code now leaves the stack of every thread in the engine log.
- **Deep band detail.** The *deep* price band's detailed core now spans at least 2% of the price (BTC: about $2,048 at $1 rows, was $1,024 at $0.50), so a session's normal movement stays inside it. Outside the core, depth is recorded in broad rows and is drawn as broad, faint bands.
- **Window style.** The window is always drawn in the pixel style; the chart and the parts drawn on it keep the smooth style. The Normal / Pixel setting is gone.
- **Turkish.** "Spread" is translated as *makas* everywhere.
- **World equities.** A new venue, `world`, has one market per stock exchange (`world-xist`, `world-xtai`, `world-xetr`; 131 exchanges). The symbol is the exchange's own local symbol, and the picker finds an exchange by its name ("istanbul"). What the chart shows depends on what a public source exposes for that exchange, and the badge says which: `L2-SNAPSHOT` (the publisher's own ladder, 3 to 10 levels a side, ten exchanges), `L1` (the best bid and ask with sizes, sixteen exchanges) or `SYNTH` (a volume-at-price profile from one-minute bars). Clocks read in the exchange's own time zone.
- **Futures, currencies, indices and bonds.** `futures-<venue>` (52 derivatives exchanges, for example `futures-cme_mini:ES1!`, `futures-eurex:FDAX1!`, `futures-bist:XU030D1!`), `forex:EURUSD`, `indices:SP:SPX` and `bonds:US10Y`. No public source shows resting orders for these instruments, so all of them are `SYNTH`: volume at price for a future, time at price for the others, which have no traded volume. Most futures venues are delayed.
- **A real order book where one exists.** For EUR/USD, GBP/USD, gold, silver, WTI, AAPL, TSLA, NVDA, SPY and QQQ the top bar links to another venue's instrument on the same underlying whose order book is public: Kraken's spot pairs and Binance's perpetual contracts. It is that venue's own instrument, and the link says so.
- **Option chain.** The **Options** button, or the `O` key, opens the chain of the instrument on the chart: every series and one row per strike, calls on the left and puts on the right, in three views (prices, activity, greeks). US shares, ETFs and the S&P 500, VIX and Russell 2000 indices come from Cboe's own delayed file (fifteen minutes behind) with sizes, volume and open interest; a crypto chart shows its coin's options on Bybit or Deribit; NSE and Borsa Istanbul underlyings come from the aggregator, without sizes.
- **Official Eurex minute candles.** `futures-eurex-official:FDAXZ2026` and `futures-eurex-official:FGBLZ2026` are drawn from Deutsche Börse's own delayed trade files (fifteen minutes behind): real open, high, low, close and quantity per minute, with no book, tape or trade side. Missing minutes are shown as gaps, never filled. The files are collected only while such a chart is open.
- **History arrives whole.** A keyless market used to show only its last few minutes when it opened on the default band: the session's history arrived as one burst that overran the connection's queue. It now arrives as one snapshot, and the 30-minute view is filled.

## Data sources and their terms

The new markets read public, keyless sources: TradingView's scanner, Yahoo's chart endpoint, the stock exchanges' own pages, Cboe's delayed quotes, Bybit, Deribit, Kraken, Binance and Deutsche Börse. [SECURITY.md](../SECURITY.md) lists every host and when it is contacted. Several of these are unofficial uses whose terms may not permit automated access. Deutsche Börse's free delayed data is for research use; its terms restrict commercial use.

## Licences

The server now bundles pypdf (BSD-3-Clause) to read the House transaction reports. It is listed in `NOTICE` and in `THIRD-PARTY-NOTICES.txt`.

## Known limits

- Cboe's book viewer and delayed options are public web pages, not a licensed feed; Cboe can limit or block automated access.
- The House reports are read in the background on first use, about 480 an hour, so the House section fills over the first hours. The owner of a trade (member, spouse, joint account or child) is in the linked report, not in the drawer.
- Hiring covers only companies that publish on Greenhouse, Lever or Ashby; companies on Workday show "no public job board".
- The corporate jets section has no free source and says so.
- No public source shows resting orders for futures, currencies, indices or bonds, or for most exchanges outside the ten `L2-SNAPSHOT` ones.
- The Eurex official market covers two dated contracts, December 2026 DAX and Euro-Bund, and stops when they expire.
- Option chains exist for US, NSE and Borsa Istanbul underlyings and for crypto coins; none was found for European, Japanese or Hong Kong underlyings.
- The known limits of 1.6.0 still apply, including the unsigned installers. See the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
