# FlowMap 1.7.0

FlowMap 1.7.0 replaces the synthetic US-equity heatmap with real order-book depth, fills the Research drawer from free public sources, adds a market map of US stocks and coins, and loads price history on every price range. The full list is in the [changelog](../CHANGELOG.md).

## What changed

- **Real depth for US stocks.** Without any key, a US stock's heatmap, DOM ladder, bid/ask and prints come from the four Cboe US equity exchanges (BZX, BYX, EDGX, EDGA): the top five levels a side, read every five seconds, from 04:00 to 20:00 New York time. It is not the consolidated US book: NYSE and Nasdaq are not part of it, and the depth chip says so. The synthetic depth that earlier versions drew from bar volume is gone.
- **History on every price range.** The first-launch history was skipped on the default *deep* range, so a new symbol started with a few seconds of data. It now loads on every range. History is price only (price line, volume and, for crypto, CVD); no depth is drawn for the time before the app was watching.
- **Cursor readout.** The price axis and the time axis show a tag at the cursor with the price and the day and time; the readout box uses full words.
- **Market map.** The *Map* button in the top bar opens a treemap of the 500 largest US stocks by sector, or of the 100 largest coins. A tile opens its chart.
- **Macro ticker.** SOFR (New York Fed) and the 10Y–2Y spread (US Treasury) now show without a key. The high-yield spread and the stress regime need a free FRED API key (`FRED_API_KEY`).
- **Research drawer on real sources.** On a US stock: risk-factor changes and the language of earnings releases (SEC EDGAR), government contract awards (USAspending.gov), House members' trades (House Clerk reports), model gamma levels (Cboe delayed options), short-sale volume (FINRA Reg SHO) and hiring (public Greenhouse, Lever and Ashby job boards). On a coin, its own tabs: perpetual futures (Binance), options (Deribit, BTC and ETH), market data (CoinGecko, DefiLlama) and the Fear & Greed index (alternative.me). Every section says why when it has no data.
- **SEC contact e-mail.** SEC asks automated programs to name a contact. Enter yours in Settings > Data to turn on the two SEC sections; it is kept on this computer and sent only to sec.gov.
- **Long sessions.** After a few hours open, a zoomed-out chart could go blank (no heatmap, price line, trades or axes) each time the price moved far enough for the grid to follow it, and show stale blocks where history pages met. Both are fixed: the zoomed-out history survives a grid move, and the close-up chart keeps drawing while history pages load.
- **Engine recovery.** After a crash the engine could stay down until the app was restarted: once five quick restarts failed, the app gave up. It now tries again every minute until the engine is back, and its error dialog no longer holds up those attempts. A crash inside native code now leaves the stack of every thread in the engine log.
- **Deep band detail.** The *deep* price band's detailed core now spans at least 2% of the price (BTC: about $2,048 at $1 rows, was $1,024 at $0.50), so a session's normal movement stays inside it. Outside the core, depth is recorded in broad rows and is drawn as broad, faint bands.
- **Window style.** The window is always drawn in the pixel style; the chart and the parts drawn on it keep the smooth style. The Normal / Pixel setting is gone.
- **Turkish.** "Spread" is translated as *makas* everywhere.

## Licences

The server now bundles pypdf (BSD-3-Clause) to read the House transaction reports. It is listed in `NOTICE` and in `THIRD-PARTY-NOTICES.txt`.

## Known limits

- Cboe's book viewer and delayed options are public web pages, not a licensed feed; Cboe can limit or block automated access.
- The House reports are read in the background on first use, about 480 an hour, so the House section fills over the first hours. The owner of a trade (member, spouse, joint account or child) is in the linked report, not in the drawer.
- Hiring covers only companies that publish on Greenhouse, Lever or Ashby; companies on Workday show "no public job board".
- The corporate jets section has no free source and says so.
- The known limits of 1.6.0 still apply, including the unsigned installers. See the [1.6.0 release notes](release-notes-1.6.0.md#known-limits).
