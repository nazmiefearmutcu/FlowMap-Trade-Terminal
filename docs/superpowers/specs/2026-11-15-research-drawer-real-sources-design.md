# Research drawer on real sources

Date: 2026-11-15. Status: approved by the owner in chat (design without jets).

## Problem

The Research drawer (top bar → Research) shows four tabs, DOCS, GOV, FLOW and GEO,
with eight sections. None of them ever shows data: the client listens for
`MARKET_INTELLIGENCE` and `GEX_UPDATE` wire messages that no part of the server
sends. The collector modules in `server/src/flowmap_server/feeds/` (`capitol.py`,
`contracts.py`, `darkpool.py`, `headcount.py`, `aviation.py`) each say "this build
starts no producer". One of them reads a source that no longer exists (House Stock
Watcher answers 403). On a crypto symbol the drawer says its sources cover US
stocks only and shows nothing.

## Goal

- On a US stock, every section shows real data from a free, keyless public source,
  or says plainly why it has none for this symbol (a reason, never a guess).
- On a crypto symbol, the drawer shows its own four tabs with crypto data.
- Nothing is invented. A missing value is a dash with its reason.

## Non-goals

- Corporate jets. The owner chose to leave this section without a source: there
  is no verified free registry that maps aircraft to listed companies. The
  section stays and says so (static text, no request).
- Audio analysis of earnings calls. There is no free, lawful bulk source of call
  audio. The section becomes a text measure (see DOCS below) and says it is text.
- Senate trades. The Senate disclosure site requires accepting its terms in an
  interactive session; only House reports are read.

## Sources (all checked from the owner's machine on 2026-11-15)

| Section | Source | Notes |
|---|---|---|
| Risk-factor changes | SEC EDGAR: `www.sec.gov/files/company_tickers.json`, `data.sec.gov/submissions/CIK##########.json`, `www.sec.gov/Archives/...` | `www.sec.gov` answers 403 unless the User-Agent carries a contact e-mail (SEC fair-access rule). |
| Management language | SEC EDGAR 8-K with Item 2.02, exhibit 99.x (the earnings release) | Same contact rule. |
| Government contracts | `api.usaspending.gov/api/v2/search/spending_by_award/` | Keyless. |
| House trades | `disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip` (index), `.../ptr-pdfs/{YEAR}/{DocID}.pdf` (reports) | Reports are PDFs with embedded fonts; reading them needs `pypdf` (BSD-3, pure Python): a new server dependency. |
| Committee of a member | `unitedstates.github.io/congress-legislators/{legislators-current,committee-membership-current,committees-current}.json` | CC0. |
| Gamma exposure (stocks) | `cdn.cboe.com/api/global/delayed_quotes/options/{SYMBOL}.json` (redirects to `cdn-api.cboe.com`) | Delayed chain with OI and IV. Model in `core/gex.py`. |
| Short-sale volume | `cdn.finra.org/equity/regsho/daily/CNMSshvol{YYYYMMDD}.txt` | Pipe-separated, one file per trading day. |
| Hiring | `boards-api.greenhouse.io/v1/boards/{slug}[/jobs]`, `api.lever.co/v0/postings/{slug}?mode=json`, `api.ashbyhq.com/posting-api/job-board/{slug}` | Only companies that publish on these boards. Workday is not read. |
| Crypto perpetuals | `fapi.binance.com/fapi/v1/premiumIndex`, `/fapi/v1/openInterest`, `/futures/data/globalLongShortAccountRatio`, `/futures/data/takerlongshortRatio` | Only coins with a USDT perpetual. |
| Crypto options | `www.deribit.com/api/v2/public/get_book_summary_by_currency?currency={BTC,ETH}&kind=option` | BTC and ETH only. |
| Crypto market | `api.coingecko.com/api/v3/coins/markets`, `api.llama.fi/protocols`, `api.llama.fi/v2/chains` | TVL only when DefiLlama lists the coin's gecko id. |
| Crypto sentiment | `api.alternative.me/fng/?limit=30` | Market-wide, not per coin. |

## The SEC contact

SEC asks automated clients to name a contact in the User-Agent. The app never
sends the user's details on its own. Settings → Data gets a field, "SEC contact
e-mail". The client keeps it in its settings and sends it to its own server in the
`X-SEC-Contact` request header on the two SEC section requests only (never in a
URL). The server checks it has an e-mail shape and uses
`FlowMap/<version> <contact>` as the User-Agent for `sec.gov` hosts only. The
environment variable `SEC_CONTACT_EMAIL` is the fallback (desktop shell passes
it through like `FRED_API_KEY`). Without either, the two SEC sections answer
`unavailable` with reason `sec_contact_missing`, and the drawer says where to set it.

## Server

New package `server/src/flowmap_server/research/`, one module per source family,
each under the 800-line module budget:

- `base.py`: the section result and shared plumbing.
  - `SectionResult`: `status` (`ok` | `empty` | `unavailable` | `not_applicable`),
    `reason` (short machine token or None), `source` (publisher name), `as_of`
    (ISO date of the observation, or None), `fetched_ns`, `stale` (bool), `data`
    (section-specific dict or None).
  - A TTL cache keyed by (section, symbol) that serves the last good result marked
    `stale=True` when a refresh fails, and does not retry a failed key for 60 s
    (the macro service's rules). Injectable clock.
  - Bounded body reads: reuse the capped reader from `data/market_map.py` (move it
    to a shared helper if needed; one copy only). Cap per source, stated in each module.
  - Clean error logging: no URLs with symbols, no headers.
- `sec.py`: ticker → CIK (24 h cache); filings list; `risk_factors(symbol)`: the
  two newest 10-K or 10-Q filings whose Item 1A text is at least 500 characters;
  HTML stripped to text lines; Item 1A located by heading and ended at the next
  `Item 1B`/`Item 2` heading; a line diff (added and removed lines, each capped at
  40 lines, each line at 400 characters); data: form, filed date, previous form and
  date, added, removed, and `triggers` (lines added that contain one of a fixed,
  documented word list: going concern, material weakness, restatement,
  investigation, subpoena, default, impairment, cybersecurity incident).
  `management_language(symbol)`: the two newest 8-K filings with Item 2.02 and an
  exhibit 99.x; text of the exhibit; counts per 1000 words of a fixed, documented
  hedging list and uncertainty list (our own short lists, written in the module,
  not a licensed dictionary); data: filed dates, both rates for the newest and the
  previous release, and the change. TTL 6 h.
- `contracts.py`: recipient search by the company's SEC name with the legal suffix
  removed (Inc, Corp, Corporation, Co, Ltd, plc, Holdings, N.V., the trailing
  punctuation); contract award types A–D; last 365 days; top 10 by amount; data:
  award id, recipient, agency, amount, date, description. `empty` when no award.
  TTL 6 h. The old `feeds/contracts.py` and its tests are removed.
- `congress.py`: the House reports pipeline.
  - Index: the current and previous year's `FD.zip` (cap 5 MB each), rows with
    FilingType `P`; refreshed every 6 h.
  - Reports: downloaded once each (cap 2 MB), cached on disk under the app data
    directory `research/house-ptr/{year}/{DocID}.pdf` with the parsed rows in
    `{DocID}.json`; at most 40 new reports per refresh so a cold start is gentle;
    a background task started by the app lifespan fills the cache, newest first.
  - Parse with `pypdf` text extraction: one row per transaction with asset name,
    ticker (the `(XXXX)` in the asset line), type (P → Purchase, S/S (partial) →
    Sale, E → Exchange shown as such), transaction date, amount range text, owner
    code. Rows without a ticker are kept but never matched to a symbol.
  - Members: name, state and district from the index row; committees from the
    unitedstates JSON matched by bioguide via (last name, state, district); 24 h.
  - `trades(symbol)`: rows for the ticker, newest transaction first, at most 25;
    data includes `coverage`: how many reports of the index are parsed so far, so
    the drawer can say "read 120 of 468 reports".
  - The old `feeds/capitol.py` and its tests are removed.
- `options.py`: `equity_gex(symbol)` from the Cboe delayed chain (cap 20 MB; drop
  contracts with zero OI) and `crypto_gex(base)` from Deribit (BTC, ETH; use
  `mark_iv`, `underlying_price`, `open_interest`, expiry from the instrument name).
  Both feed the existing model in `core/gex.py`; data: spot, net GEX (USD),
  call wall, put wall, gamma flip (None when no sign bracket), put/call OI ratio,
  and for crypto also max pain for the nearest monthly expiry. TTL 15 min.
- `short_volume.py`: the newest available CNMS file (walk back up to 7 calendar
  days; cap 10 MB) plus the four before it; data: date, short, short-exempt,
  total, short ratio, and the 5-day average ratio. TTL until the next weekday 18:00 New York.
  The old `feeds/darkpool.py` and its tests are removed.
- `hiring.py`: board discovery per company: a small curated map
  (symbol → provider, slug) written in the module for known large companies, then
  Greenhouse auto-discovery from slug candidates built from the SEC name, accepted
  only when the board's own name matches the company name (normalized tokens).
  Data: provider, total openings, R&D openings (department or title matches
  engineering, research, R&D, scientist, data, machine learning, hardware,
  software), postings first published in the last 30 days and the 30 before
  (when the provider gives a publish date), and the change in percent; status
  `expanding` (>+10 %), `slowing` (<-10 %), `steady`. `not_applicable` with
  reason `no_public_board` when no board is found. TTL 12 h. The old
  `feeds/headcount.py` and its tests are removed.
- `crypto.py`: `derivatives(base)`, `options(base)` (delegates to `options.py`),
  `market(base)`, `sentiment()`. Symbol mapping: the base asset of the chart
  symbol (`binance:ETHUSDT` → `ETH`). CoinGecko id from `coins/markets` (top 250,
  6 h cache), picking the highest market cap on a symbol clash. TTLs: derivatives
  60 s, options 15 min, market 10 min, sentiment 1 h.
- `api/research.py`: `GET /api/research/{market}/{section}?symbol=` with
  market `us` (sections `risk-factors`, `language`, `contracts`, `house-trades`,
  `gex`, `short-volume`, `hiring`) or `crypto` (`derivatives`, `options`,
  `market`, `sentiment`). camelCase JSON of `SectionResult`. 422 for an unknown
  market or section or a malformed symbol; never 5xx for a source failure (that is
  `unavailable` in the body). Services live lazily on `app.state` and are closed in
  `_lifespan`, as the market map's.
- `aviation.py` stays as it is (unwired); the jets section makes no request.

## Client

- `net/researchApi.ts`: one fetch per (market, section, symbol) with a validator
  per section (finite numbers or null, strings, bounded arrays). The SEC contact
  is sent as the `X-SEC-Contact` header on the two SEC sections when set.
- `app/useResearchSection.ts`: fetch when the drawer shows that section for the
  active symbol; abort on symbol change, tab change or unmount; keep the last
  result per (market, section, symbol) for the drawer's lifetime; refresh on
  re-open when older than the section's TTL hint.
- Drawer: the tab set follows the active symbol's market. US stock: DOCS, GOV,
  FLOW, GEO as today. Crypto: PERP, OPTIONS, MARKET, SENTIMENT. Other markets: the
  existing "not covered" note.
- Each section renders four states: loading; data; `empty`/`not_applicable` with
  its reason in the user's language; `unavailable` with its reason and, for
  `sec_contact_missing`, the place to set the contact. `stale` adds "last
  successful read" with the time.
- DOCS: "Risk factor changes" (as today, from real data) and "Management language"
  (replaces the vocal-stress card: hedging and uncertainty per 1000 words, the
  change against the previous release, the release dates; the title and text say
  it is measured from the written release, not audio).
- GOV: contracts (as today) and House trades (member, party-free: name, state and
  district, committee list, type, amount range, date; and the coverage line).
- FLOW: GEX (as today plus put/call OI ratio) and short-sale volume (the
  "OTC non-ATS" line becomes "short-exempt volume" and a 5-day average is added).
- GEO: hiring (provider named, the three counts, the change, status). Jets: the
  static no-source note.
- Crypto tabs: PERP (funding rate per 8 h and annualized, next funding time, open
  interest in coins and USD, long/short account ratio, taker buy/sell ratio);
  OPTIONS (BTC/ETH: GEX levels, put/call OI ratio, max pain; other coins:
  not applicable); MARKET (price change 24 h/7 d/30 d, market cap rank, supply
  circulating/total/max, distance from all-time high, TVL when listed);
  SENTIMENT (Fear & Greed value, label, 7-day and 30-day path).
- The wire-message path (`handleStreamMsg`, `ingestIntel`, `ingestGex`) and the
  demo seed stay for the offline demo harness; the drawer reads the REST results
  first.
- Settings → Data: "SEC contact e-mail" text field with a one-line explanation.
- All new text in English and Turkish (spread = makas; see the 2026-11-15 rule).

## Testing

- Server: every parser is a pure function with fixture tests (no network): SEC
  ticker map, submissions, Item 1A extraction and diff, 8-K exhibit choice and
  rates; USAspending reply; FD index text; a real House PTR PDF fixture parsed with
  pypdf; committee matching; Cboe chain and Deribit summary into the GEX model;
  FINRA file; each hiring provider reply and the board-name check; each crypto
  reply. Service tests with injected fetchers and clock: TTL, stale on failure,
  60 s retry floor, `sec_contact_missing`, `not_applicable`. API tests for routing,
  422s and camelCase.
- Client: validators, the hook (fetch, abort, cache, refresh), each section's four
  states, the crypto tab set, the settings field and the header.
- Live check in the preview with the real sources: NVDA, LMT, AAPL, PLTR on every
  US section; BTCUSDT, ETHUSDT and a small coin on every crypto section; English
  and Turkish.

## Risks

- Cboe, FINRA, the House Clerk and SEC can change formats or rate-limit; each
  section fails on its own with a reason.
- House report parsing depends on the e-filed PDF layout; scanned paper filings
  give no text and are counted as unreadable in `coverage`.
- Hiring covers only companies on Greenhouse, Lever or Ashby.
