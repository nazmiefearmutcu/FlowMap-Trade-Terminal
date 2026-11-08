/**
 * Time-bucketed OHLCV candle synthesis from the trade stream.
 *
 * A pure, framework-free builder: trades go in one at a time, candles come out.
 * It is the price-structure source for the indicator kernels (indicators/) — the
 * depth heatmap shows resting liquidity, but SMA/RSI/MACD-class studies need
 * candles, and this feed's honest way to get them is to aggregate the tape.
 *
 * Semantics (all pinned by synth.test.ts):
 *  - Bucket = `floor(ts_ns / timeframe)`; each trade merges into its bucket:
 *    `o` = price of the EARLIEST trade by `ts_ns` (ties: first arrival),
 *    `h`/`l` = extremes, `c` = price of the LATEST
 *    trade by `ts_ns` (ties: latest arrival), `v` = Σ size, `trades` = count.
 *  - OUT-OF-ORDER trades (a straggler with an older ts) merge into their own
 *    older bucket whenever it is still resident; `c` only moves for trades at
 *    or after that bucket's last seen ts, so a late trade never overwrites a
 *    newer close with an older price.
 *  - DUPLICATES are suppressed ONLY by identity: a trade carrying a connection
 *    `seq` whose `(ts_ns, seq)` pair matches one of the last {@link DUP_WINDOW}
 *    sequenced trades is a re-delivery (a WS reconnect overlap) and is dropped.
 *    A trade without a sequence (absent, 0 = unknown, or not a safe integer)
 *    always merges: venue timestamps are millisecond resolution, so two distinct
 *    fills can share `(ts, price, size)` and both must merge. The window is
 *    honest about its reach: a re-delivery of MORE than DUP_WINDOW sequenced
 *    trades would double-count volume.
 *  - Bounded ring ({@link DEFAULT_RING} buckets, drop-oldest): a trade older
 *    than the oldest resident bucket is counted in `droppedLate` and ignored.
 *  - Non-finite price/size or a negative ts is quarantined (`nonFinite`) —
 *    corrupt wire data must not poison a candle.
 *
 * Per-push cost is O(1): the re-delivery guard is a seq-keyed Map bounded to
 * DUP_WINDOW identities, and nothing recomputes over history. Bucket identity
 * uses bigint math (`ts / tf`) so ns-scale timestamps never lose precision.
 */

/** One synthesized OHLCV candle. All fields are plain numbers except the times. */
export interface Candle {
  /** Bucket index (`floor(ts / timeframe)`) — the monotonic candle id. */
  bi: number;
  /** Bucket start time in ns (`bi * timeframe`). */
  t0Ns: bigint;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Accumulated trade size (base units, not quote). */
  v: number;
  /** Merged (dup-suppressed) trade count — a liquidity/participation proxy. */
  trades: number;
  /** ts of the earliest trade merged into this bucket (open authority). */
  firstTsNs: bigint;
  /** ts of the latest trade merged into this bucket (close authority). */
  lastTsNs: bigint;
}

/** Default candle ring — 2000 buckets ≈ 33 h of 1-minute candles. */
export const DEFAULT_RING = 2000;
/**
 * Re-delivery suppression window: the number of recent sequenced trades whose
 * identity is remembered. It covers the server's attach snapshot (the last 500
 * trades of the tape), so a reconnect's re-sent tail is recognised in full.
 */
export const DUP_WINDOW = 512;

export interface SynthStats {
  /** Trades merged into candles. */
  merged: number;
  /** Re-delivered sequenced trades inside the window (skipped). */
  dupSkipped: number;
  /** Trades older than the oldest resident bucket (skipped). */
  droppedLate: number;
  /** Non-finite price/size or negative ts (quarantined). */
  nonFinite: number;
}

export interface CandleSynth {
  /** Current timeframe in ns per bucket. */
  readonly timeframeNs: number;
  /**
   * Merge one trade. `seq` is the trade's connection sequence when the wire
   * carries one: a repeat of the same `(ts, seq)` within the dedup window is a
   * re-delivery and is dropped. Omitted, 0 (unknown), or not a safe integer, the
   * trade always merges. Quarantines/late-drops per the module contract.
   */
  push(tsNs: bigint, price: number, size: number, seq?: number): void;
  /** Oldest-first snapshot of the resident candles (one array per call). */
  candles(): Candle[];
  /** Number of resident buckets. */
  count(): number;
  /** Monotonic mutation counter — cheap "did anything change" for repaint loops. */
  version(): number;
  /**
   * Monotonic count of merges into a CLOSED bucket (one older than the newest
   * bucket, including a new candle inserted into a gap). Streaming indicator
   * state built on those buckets is stale after one of these, so a consumer must
   * replay rather than append. Not reset by {@link reset}.
   */
  closedRevision(): number;
  /** Lifetime counters (not reset by {@link reset}). */
  stats(): SynthStats;
  /** Change the bucket size. A different timeframe resets the ring (incompatible buckets). */
  setTimeframe(ns: number): void;
  /** Drop every candle (session switch). Counters survive; version bumps. */
  reset(): void;
}

/** Validate a timeframe: a finite number ≥ 1 ns. */
function validTf(ns: number): number {
  if (!Number.isFinite(ns) || ns < 1) {
    throw new RangeError(`timeframe must be a finite number >= 1ns, got ${ns}`);
  }
  return ns;
}

/** Create a streaming candle builder for one timeframe. */
export function createCandleSynth(timeframeNs: number, ring: number = DEFAULT_RING): CandleSynth {
  if (!Number.isInteger(ring) || ring < 1) {
    throw new RangeError(`ring must be an integer >= 1, got ${ring}`);
  }
  let tf = validTf(timeframeNs);
  const tfBig = () => BigInt(Math.round(tf));

  const slots: (Candle | undefined)[] = new Array(ring);
  let firstBi: bigint | null = null; // bucket index of the oldest resident candle
  let lastBi: bigint | null = null; // bucket index of the newest candle seen
  let ver = 0;
  let closedRev = 0; // merges into a bucket older than lastBi (see closedRevision)

  // Re-delivery guard: the (seq → ts) identities of the last DUP_WINDOW merged
  // sequenced trades. The ring keeps arrival order, so the oldest identity is
  // evicted in O(1) when the window is full. Unsequenced trades are never recorded.
  const dupBySeq = new Map<number, bigint>();
  const dupRingSeq: number[] = new Array<number>(DUP_WINDOW).fill(0);
  const dupRingTs: bigint[] = new Array<bigint>(DUP_WINDOW).fill(0n);
  let dupHead = 0;
  let dupCount = 0;

  function clearDup(): void {
    dupBySeq.clear();
    dupHead = 0;
    dupCount = 0;
  }

  const stats: SynthStats = { merged: 0, dupSkipped: 0, droppedLate: 0, nonFinite: 0 };

  function clearRing(): void {
    slots.fill(undefined);
    firstBi = null;
    lastBi = null;
    clearDup();
  }

  return {
    get timeframeNs(): number {
      return tf;
    },

    push(tsNs, price, size, seq) {
      if (
        !Number.isFinite(price) ||
        !Number.isFinite(size) ||
        typeof tsNs !== 'bigint' ||
        tsNs < 0n
      ) {
        stats.nonFinite += 1;
        return;
      }
      // 0 is the wire's "no sequence" value, so only a positive safe integer keys a trade.
      const sequence = seq !== undefined && Number.isSafeInteger(seq) && seq > 0 ? seq : 0;
      const sequenced = sequence > 0;
      // --- identity-keyed re-delivery guard: an exact (ts, seq) repeat only, never by value
      if (sequenced && dupBySeq.get(sequence) === tsNs) {
        stats.dupSkipped += 1;
        return;
      }

      const bi = tsNs / tfBig();

      if (firstBi === null) {
        firstBi = bi;
      } else if (bi < firstBi) {
        // Older than the oldest resident bucket — the candle it belongs to has
        // already been evicted (its slot may have been recycled by a newer
        // bucket); merging would resurrect a stale candle and lose the head.
        stats.droppedLate += 1;
        return;
      }

      const intoClosed = lastBi !== null && bi < lastBi;
      if (lastBi === null || bi > lastBi) lastBi = bi;
      // Advance the resident window: a bucket whose slot this push just (or is
      // about to) recycled is no longer resident. Keeps span ≤ ring so the
      // snapshot walk and the late-trade test both stay O(ring) and correct.
      if (lastBi - firstBi >= BigInt(ring)) firstBi = lastBi - BigInt(ring - 1);

      const slot = Number(bi % BigInt(ring));
      const cur = slots[slot];
      if (cur === undefined || cur.bi !== Number(bi)) {
        // NOTE bi fits a double exactly while < 2^53 buckets; a 1ns timeframe
        // for 2^53 ns ≈ 104 days is far outside a session's life. Guarded below.
        const biNum = Number(bi);
        if (!Number.isSafeInteger(biNum)) {
          stats.droppedLate += 1;
          return;
        }
        slots[slot] = {
          bi: biNum,
          t0Ns: bi * tfBig(),
          o: price,
          h: price,
          l: price,
          c: price,
          v: size,
          trades: 1,
          firstTsNs: tsNs,
          lastTsNs: tsNs,
        };
      } else {
        cur.h = cur.h < price ? price : cur.h;
        cur.l = cur.l > price ? price : cur.l;
        cur.v += size;
        cur.trades += 1;
        if (tsNs < cur.firstTsNs) {
          // A straggler older than the first arrival is the true open.
          cur.o = price;
          cur.firstTsNs = tsNs;
        }
        if (tsNs >= cur.lastTsNs) {
          cur.c = price;
          cur.lastTsNs = tsNs;
        }
      }

      // Record the identity AFTER a successful merge (a dropped trade was not
      // merged, so its re-delivery should be free to merge then).
      if (sequenced) {
        if (dupCount === DUP_WINDOW) {
          // Evict the oldest identity; a newer identity that reused its seq stays.
          const oldSeq = dupRingSeq[dupHead];
          if (dupBySeq.get(oldSeq) === dupRingTs[dupHead]) dupBySeq.delete(oldSeq);
        } else {
          dupCount += 1;
        }
        dupRingSeq[dupHead] = sequence;
        dupRingTs[dupHead] = tsNs;
        dupBySeq.set(sequence, tsNs);
        dupHead = (dupHead + 1) % DUP_WINDOW;
      }

      stats.merged += 1;
      ver += 1;
      if (intoClosed) closedRev += 1;
    },

    closedRevision() {
      return closedRev;
    },

    candles() {
      if (firstBi === null || lastBi === null) return [];
      const out: Candle[] = [];
      let bi = firstBi;
      while (bi <= lastBi && out.length <= ring) {
        const c = slots[Number(bi % BigInt(ring))];
        if (c !== undefined && c.bi === Number(bi)) out.push(c);
        bi += 1n;
      }
      return out;
    },

    count() {
      if (firstBi === null || lastBi === null) return 0;
      let n = 0;
      for (let bi = firstBi; bi <= lastBi; bi += 1n) {
        const c = slots[Number(bi % BigInt(ring))];
        if (c !== undefined && c.bi === Number(bi)) n += 1;
      }
      return n;
    },

    version() {
      return ver;
    },

    stats() {
      return { ...stats };
    },

    setTimeframe(ns) {
      const next = validTf(ns);
      if (next === tf) return;
      tf = next;
      clearRing();
      ver += 1;
    },

    reset() {
      clearRing();
      ver += 1;
    },
  };
}
