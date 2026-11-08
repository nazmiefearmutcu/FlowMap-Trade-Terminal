/**
 * Symbol directory helpers (top bar) — pure, so the grouping / filtering
 * / capability-chip logic is unit-tested without the network or the DOM.
 *
 * The server's `GET /api/symbols?q=` already substring-filters; these helpers add
 * the client-side concerns: mapping a wire `market` to a display group (crypto /
 * equity / sim), deriving the small capability chips each row shows, and ranking
 * the directory for the picker.
 *
 * The venue half of this module (`VenueInfo` → `venueOptions`) backs the picker's
 * venue selector. `GET /api/venues` reports ~106 venues; a market string is a
 * venue `id` or `id + "-" + segment` (no venue id contains a `-`, so a single
 * partition parses it). The catalog is ALSO the grouping authority: once it has
 * been fetched, `marketGroup` answers from the server's `assetClass` instead of
 * guessing, and the old string heuristic survives only as the pre-fetch fallback.
 */

import { t as activeT, tFor } from '../i18n';
import { honestDepthTier } from '../gl/depthTier';

export interface SymbolEntry {
  market: string;
  symbol: string;
  capability: Record<string, unknown>;
  note?: string;
}

export type SymbolGroupKey = 'crypto' | 'equity' | 'sim';

/** One venue as `GET /api/venues` reports it. */
export interface VenueInfo {
  /** Venue id: an exchange (`kraken`), or `equity` / `sim`. Never contains `-`. */
  id: string;
  /** `crypto` | `equity` | `sim` — the grouping authority once fetched. */
  assetClass: string;
  /** `L2` for a native connector, `L2-snapshot` for a ccxt-polled book. */
  depth: string;
  /** True when a hand-written connector streams true incremental book diffs. */
  native: boolean;
  /** Sub-markets that suffix the id (`binance` → spot/usdm/coinm); usually empty. */
  segments: string[];
}

/** One row of the picker's venue list — a selectable scope plus how to badge it. */
export interface VenueOption {
  /** The wire `market` to enumerate, or `all` for the bundled cross-venue directory. */
  market: string;
  label: string;
  group: SymbolGroupKey | 'all';
  /** Depth tier to badge, or `''` when the honest tier is per-symbol (see `venueOptions`). */
  depth: string;
  native: boolean;
}

/** The scope that serves the bundled, instant `market=all` directory. */
export const ALL_VENUES = 'all';

/** English group names, kept as search aliases in every locale. Never rendered. */
const GROUP_SEARCH_ALIAS: Record<SymbolGroupKey, string> = {
  crypto: 'Crypto',
  equity: 'Equity',
  sim: 'Simulated',
};

/** Translation keys for the short group words on the top bar's venue chip (the long form says 'Simulated'). */
const VENUE_GROUP_KEY: Record<SymbolGroupKey, string> = {
  crypto: 'search.group.crypto',
  equity: 'search.group.equity',
  sim: 'search.group.sim',
};

/** Translates a message key; the pure helpers default to English. */
export type Translate = (key: string) => string;
const englishT: Translate = (key) => tFor('en', key);

// --- venue catalog registry -------------------------------------------------
// A plain module-level cache rather than a subscribable store: every consumer
// (top bar, palette rows) re-renders on its own cadence, and the fallback
// heuristic below already agrees with the catalog for every venue this build
// ships — so a pre-fetch frame cannot show a group the catalog would contradict.
let venueGroups: ReadonlyMap<string, SymbolGroupKey> = new Map();
let venueCatalog: readonly VenueInfo[] = [];

/** Narrow a wire `assetClass` to a display group, or null when it is unknown. */
export function venueAssetGroup(assetClass: string | undefined): SymbolGroupKey | null {
  if (assetClass === 'crypto' || assetClass === 'equity' || assetClass === 'sim') return assetClass;
  return null;
}

/** Install the `/api/venues` payload as the grouping authority. */
export function setVenueCatalog(venues: readonly VenueInfo[]): void {
  const groups = new Map<string, SymbolGroupKey>();
  for (const v of venues) {
    const key = venueAssetGroup(v?.assetClass);
    // An unrecognised assetClass is left OUT rather than coerced, so such a venue
    // keeps falling through to the heuristic instead of being mislabelled.
    if (key && typeof v.id === 'string' && v.id !== '') groups.set(v.id.toLowerCase(), key);
  }
  venueGroups = groups;
  venueCatalog = venues;
}

/** The installed catalog (empty before `/api/venues` resolves). */
export function getVenueCatalog(): readonly VenueInfo[] {
  return venueCatalog;
}

/** Drop the catalog — the pre-fetch state. Exists for tests and for a failed reload. */
export function resetVenueCatalog(): void {
  venueGroups = new Map();
  venueCatalog = [];
}

/** The exchange half of a market string: `binance-usdm` → `binance`, `okx` → `okx`. */
export function marketVenueId(market: string): string {
  const dash = market.indexOf('-');
  return (dash < 0 ? market : market.slice(0, dash)).toLowerCase();
}

/**
 * Map a wire `market` to its display group — from the fetched `/api/venues`
 * `assetClass` when we have it, else from the legacy string heuristic (which
 * defaults ~104 crypto venue ids to crypto, right but blind).
 */
export function marketGroup(market: string): SymbolGroupKey {
  const m = market.toLowerCase();
  const known = venueGroups.get(marketVenueId(m));
  if (known) return known;
  if (m === 'sim') return 'sim';
  if (m === 'equity' || m === 'stock' || m === 'us-equity') return 'equity';
  // binance-spot / binance-futures / crypto / anything else → crypto.
  return 'crypto';
}

/**
 * The top bar's venue text. Crypto shows the market string itself (`kraken`,
 * `binance-usdm`) — with ~104 venues, "Crypto" alone no longer identifies
 * anything — while equity / sim keep their group word, which IS their venue.
 */
export function venueLabel(market: string, t: Translate = englishT): string {
  const group = marketGroup(market);
  return group === 'crypto' ? market : t(VENUE_GROUP_KEY[group]);
}

/**
 * The translated group word (`Crypto` / `Kripto`, `Equity` / `Hisse`, `Sim`).
 * Surfaces that name a group in running text (a tooltip, a row hint) use this
 * rather than the internal key (`crypto`, `equity`, `sim`), which is not UI text.
 */
export function venueGroupLabel(group: SymbolGroupKey, t: Translate = englishT): string {
  return t(VENUE_GROUP_KEY[group]);
}

/** Every market string a venue can be subscribed as (one per segment, else the bare id). */
export function venueMarkets(venue: VenueInfo): string[] {
  const segments = Array.isArray(venue.segments) ? venue.segments : [];
  return segments.length > 0 ? segments.map((s) => `${venue.id}-${s}`) : [venue.id];
}

/**
 * Flatten the catalog into the picker's venue list: the bundled `all` scope
 * first, then the native venues (true incremental books — including equity and
 * sim), then the ccxt-served rest, each preserving catalog order.
 *
 * The depth badge is carried VERBATIM off the catalog for every venue, because
 * the server reports each venue's real tier rather than deriving it from
 * `native` — so equity reads `SYNTH`, a ccxt venue reads `L2-snapshot`, and only
 * a venue that truly streams diffs reads `L2`. The bundled `all` scope spans
 * every tier at once, so it honestly carries none.
 */
export function venueOptions(venues: readonly VenueInfo[]): VenueOption[] {
  const native: VenueOption[] = [];
  const served: VenueOption[] = [];
  for (const v of venues) {
    if (typeof v?.id !== 'string' || v.id === '') continue;
    const group = venueAssetGroup(v.assetClass) ?? marketGroup(v.id);
    const depth = typeof v.depth === 'string' ? v.depth : '';
    for (const market of venueMarkets(v)) {
      (v.native ? native : served).push({ market, label: market, group, depth, native: !!v.native });
    }
  }
  return [
    { market: ALL_VENUES, label: 'All markets', group: 'all', depth: '', native: true },
    ...native,
    ...served,
  ];
}

/**
 * Fuzzy-rank venue options by the query, best first. Ranks on the market string
 * (what the user types) and falls back to the label, so `usdm` finds
 * `binance-usdm` and `all` finds the bundled scope. Empty query keeps the
 * curated order above.
 */
export function rankVenueOptions(
  options: readonly VenueOption[],
  q: string,
  limit = 300,
): VenueOption[] {
  if (q.trim() === '') return options.slice(0, limit);
  const scored: Array<{ option: VenueOption; score: number }> = [];
  for (const option of options) {
    const score = Math.max(
      fuzzyScore(searchFold(q), searchFold(option.market)),
      fuzzyScore(searchFold(q), searchFold(option.label)) - 20,
    );
    if (score >= 0) scored.push({ option, score });
  }
  scored.sort((a, b) => b.score - a.score || a.option.market.length - b.option.market.length);
  return scored.slice(0, limit).map((r) => r.option);
}

/**
 * Match key for symbol search. Canonical decomposition with combining marks
 * removed (so a composed `é` and a decomposed one agree), then the Turkish dotted
 * and dotless I folded onto `i` (`İ`, `I`, `ı` all become `i`), then lowercased.
 * `iz`, `İZ`, `Iz` and `ız` therefore name the same search.
 */
export function searchFold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[İIı]/g, 'i').toLowerCase();
}

/**
 * How well a folded query names an entry's display group: its key (`crypto`), its
 * English alias (`Simulated`) and its translated word in the active locale (`Kripto`,
 * `Hisse`). Ranked below a direct symbol hit, so a group word surfaces the group
 * without outranking a ticker that is spelled the same way.
 */
function groupMatchScore(needle: string, market: string, t: Translate): number {
  const key = marketGroup(market);
  const words = [key, GROUP_SEARCH_ALIAS[key], venueGroupLabel(key, t)];
  let best = -1;
  for (const word of words) {
    const s = fuzzyScore(needle, searchFold(word)) - 300;
    if (s > best) best = s;
  }
  return best;
}

/**
 * Word-boundary positions of `text`: index 0, any character right after a
 * separator (`-`, `_`, `.`, `:`, `/`, space, `+`), and any lower→UPPER camelCase
 * transition (so `XBTUSDT`-style all-caps tickers do NOT fire it — every char is
 * uppercase, there are no inner word starts to reward). Computed on the RAW text,
 * before lowercasing, because lowercasing erases the camel signal.
 */
function isWordBoundary(raw: string, i: number): boolean {
  if (i <= 0) return false; // index 0 is rewarded separately (start-of-string)
  const prevCh = raw[i - 1];
  if ('-_.:/ +'.includes(prevCh)) return true;
  const cur = raw[i];
  const prev = raw[i - 1];
  return cur >= 'A' && cur <= 'Z' && prev >= 'a' && prev <= 'z';
}

/**
 * Fuzzy score of `query` against `text` (higher = better; -1 = no match). Tiers,
 * highest first: exact → prefix → substring → scattered subsequence. Within the
 * subsequence tier, contiguous runs, a start-of-string hit and WORD-BOUNDARY hits
 * are rewarded, and shorter texts win ties — so "BT" ranks BTCUSDT above a
 * coincidental match in a longer ticker, and "EU" ranks `ETH/USD`'s `U` (an
 * after-separator hit) above a mid-word `u`. This is the ranking the
 * substring-only server filter lacked.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const sub = t.indexOf(q);
  if (sub >= 0) return 600 - sub - t.length * 0.1;
  let qi = 0;
  let score = 0;
  let run = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      run = ti === prev + 1 ? run + 1 : 1;
      score += run;
      if (ti === 0) score += 5;
      // A subsequence hit on a word start (after `-`, `.`, `/`, camelCase, …) is
      // worth much more to a trader than the same letters scattered mid-word.
      else if (isWordBoundary(text, ti)) score += 4;
      prev = ti;
      qi += 1;
    }
  }
  if (qi < q.length) {
    // Trader spellings carry separators the compact ticker does not: "btc usdt",
    // "eth/usd", "brk.b". Retry with every separator stripped from BOTH sides so
    // those queries reach "BTCUSDT" (and a compact query reaches "ETH/USD"),
    // scored just below an equally-direct match so normal rankings are intact.
    // Only reached when the direct pass FAILED, so existing scores never shift.
    const qc = q.replace(/[\s\-/_.]+/g, '');
    const tc = t.replace(/[\s\-/_.]+/g, '');
    if (qc !== q || tc !== t) {
      const s = fuzzyScore(qc, tc);
      return s < 0 ? -1 : s - 5;
    }
    return -1; // not every query char was consumed → no match
  }
  return 100 + score - t.length * 0.1;
}

/**
 * Fuzzy-rank a directory by the query, best first. A match on the SYMBOL ranks
 * above a match on the market/venue. Empty query returns the input order (capped).
 */
export function fuzzyRank(
  entries: readonly SymbolEntry[],
  q: string,
  limit = 60,
  t: Translate = activeT,
): SymbolEntry[] {
  const needle = searchFold(q.trim());
  if (needle === '') return entries.slice(0, limit);
  const scored: Array<{ entry: SymbolEntry; score: number }> = [];
  for (const e of entries) {
    const s = Math.max(
      fuzzyScore(needle, searchFold(e.symbol)),
      fuzzyScore(needle, searchFold(e.market)) - 60,
      groupMatchScore(needle, e.market, t),
    );
    if (s >= 0) scored.push({ entry: e, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.entry.symbol.length - b.entry.symbol.length);
  return scored.slice(0, limit).map((r) => r.entry);
}

/**
 * Small capability chips for a directory row / the top bar. Honest: shows the
 * depth tier the chart is actually drawn with (`honestDepthTier`, the same
 * verdict the renderer's ramp and the DOM ladder badge use) plus the tape and
 * side tiers, uppercased.
 *
 * A recorded-density replay keeps its real depth tier (a keyless equity
 * recording still reads `SYNTH`) and adds `RECORDED DENSITY` as a provenance
 * chip beside it. A replay with no recorded provenance reads `SYNTH`, because
 * the chart is drawn that way. A simulated feed (`synthetic: true`) adds a
 * `SIM` chip.
 */
export function capabilityChips(capability: Record<string, unknown> | null | undefined): string[] {
  if (!capability) return [];
  const chips: string[] = [];
  const depth = honestDepthTier(capability);
  if (typeof depth === 'string') chips.push(depth.toUpperCase());
  if (capability.depth_provenance === 'recorded-density') chips.push('RECORDED DENSITY');
  if (capability.synthetic === true) chips.push('SIM');
  const tape = capability.tape ?? capability.trades;
  if (typeof tape === 'string') chips.push(`TAPE ${tape.toUpperCase()}`);
  const side = capability.trade_side;
  if (typeof side === 'string') chips.push(`SIDE ${side.toUpperCase()}`);
  return chips;
}

/**
 * THE capability-chip classifier (honesty first). One function, every surface — the
 * top bar and the symbol palette must make the same fidelity claim about the same
 * string, or the app contradicts itself depending on where you look.
 *
 * Four tiers, and every reachable chip string lands in exactly one:
 *
 * - `cap--depth`            REAL, streamed venue depth: `L2` (native crypto /
 *                           sim), `L1` (Alpaca top-of-book — real quotes, fewer
 *                           of them; the CHIP TEXT carries that distinction).
 * - `cap--depth cap--caution`  REAL but lower fidelity: `L2-SNAPSHOT`, a ccxt
 *                           book re-read whole each tick instead of diffed. A
 *                           ccxt venue must never look like a native L2 feed —
 *                           and it is not fabricated data either.
 * - `cap--synth`            FABRICATED: `SYNTH` / `SYNTH_PROFILE`, equity depth
 *                           reconstructed from a price+volume print. Two
 *                           spellings of one thing (server core/session.py keeps
 *                           `SYNTH_PROFILE` for compatibility), so they MUST
 *                           classify identically.
 * - `cap--synth`            also `SIM`: a simulated feed (`synthetic: true`) whose
 *                           book, prints and sides are generated, not observed.
 * - `cap--na`               NO CLAIM: `N/A` — the finnhub equity tier ships no
 *                           book at all (server feeds/equity.py) — and
 *                           `UNKNOWN`, the fallback `data/venues.py::_feed_depth`
 *                           emits for a feed that states no depth. "Nothing" and
 *                           "we don't know" may not borrow the accent that means
 *                           "a real order book".
 *
 * Tape and side chips follow the same real / real-but-lagging / absent shape:
 * polled tape is the venue's OWN prints on a timer (caution, not fabricated), and
 * an inferred or missing aggressor side is a caution step-down on a bare chip.
 */
export function capabilityChipClass(chip: string): string {
  if (chip === 'RECORDED DENSITY') return 'cap cap--depth cap--caution';
  // A simulated feed generates its book, prints and sides: fabricated, so the synthetic accent.
  if (chip === 'SIM') return 'cap cap--synth';
  if (chip.startsWith('TAPE')) {
    return chip.includes('POLL') ? 'cap cap--tape cap--caution' : 'cap cap--tape';
  }
  if (chip.startsWith('SIDE')) {
    const side = sideValue(chip);
    return side.includes('INFERRED') || isNoSideClaim(side) ? 'cap cap--caution' : 'cap';
  }
  // --- depth chips ---
  if (chip.startsWith('SYNTH')) return 'cap cap--synth';
  if (isNoClaimTier(chip)) return 'cap cap--na';
  if (chip.includes('SNAPSHOT')) return 'cap cap--depth cap--caution';
  return 'cap cap--depth';
}

/**
 * Depth strings that assert NO fidelity: `N/A` (the tier ships no book) and
 * `UNKNOWN` (the server could not read a depth off the feed). Neither may fall
 * through to the real-depth accent — falling through is the overclaim.
 */
function isNoClaimTier(chip: string): boolean {
  return chip === 'N/A' || chip === 'NA' || chip === 'NONE' || chip === 'UNKNOWN' || chip === '';
}

/** The value after the `SIDE ` word of a side chip (`SIDE NA` → `NA`). */
function sideValue(chip: string): string {
  return chip.slice('SIDE'.length).trim();
}

/**
 * Side values that assert NO aggressor attribution: the feed reported none (`NA`,
 * `N/A`, `NONE`), or we do not know it (`UNKNOWN`). A bare `SIDE UNKNOWN` read as
 * a clean chip before this, which claimed more than the data carried.
 */
function isNoSideClaim(side: string): boolean {
  return side === 'NA' || side === 'N/A' || side === 'NONE' || side === 'UNKNOWN' || side === '';
}

/**
 * Hover text spelling out what a lower-fidelity chip actually means, or undefined.
 * The text is a translation key (`depthChip.*`) resolved through `t`; without a
 * translator it reads in English.
 */
export function capabilityChipTitle(chip: string, t: Translate = englishT): string | undefined {
  if (chip === 'RECORDED DENSITY') return t('depthChip.recorded');
  if (chip === 'SIM') return t('depthChip.simulated');
  if (chip.startsWith('TAPE')) {
    return chip.includes('POLL') ? t('depthChip.tapePoll') : undefined;
  }
  if (chip.startsWith('SIDE')) {
    const side = sideValue(chip);
    if (side.includes('INFERRED')) return t('depthChip.sideInferred');
    if (isNoSideClaim(side)) return t('depthChip.sideNone');
    return undefined;
  }
  if (chip.startsWith('SYNTH')) return t('depthChip.synth');
  if (chip === 'UNKNOWN') return t('depthChip.unknown');
  if (isNoClaimTier(chip)) return t('depthChip.none');
  if (chip.includes('SNAPSHOT')) return t('depthChip.snapshot');
  if (chip === 'L1') return t('depthChip.l1');
  return undefined;
}

/**
 * The chip's VISIBLE text in the active locale. The English token stays the chip's
 * identity (the React key, the CSS class from {@link capabilityChipClass}, the
 * title from {@link capabilityChipTitle}); only what a reader sees is translated.
 * A chip with no translated wording shows its token unchanged.
 */
export function capabilityChipLabel(chip: string, t: Translate = activeT): string {
  if (chip === 'RECORDED DENSITY') return t('chip.recordedDensity');
  if (chip === 'SIM') return t('chip.sim');
  if (chip === 'SYNTH' || chip === 'SYNTH_PROFILE') return t('chip.synth');
  if (chip === 'L2-SNAPSHOT') return t('chip.snapshot');
  if (chip === 'UNKNOWN') return t('chip.unknown');
  if (chip.startsWith('TAPE ')) {
    const value = chip.slice('TAPE'.length).trim();
    const shown = value === 'POLL' ? t('chip.poll') : value === 'TICK' ? t('chip.tick') : value;
    return `${t('chip.tape')} ${shown}`;
  }
  if (chip.startsWith('SIDE')) {
    const side = sideValue(chip);
    const shown = side.includes('INFERRED')
      ? t('chip.inferred')
      : isNoSideClaim(side) ? t('chip.none') : side;
    return `${t('chip.side')} ${shown}`;
  }
  return chip;
}
