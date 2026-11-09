/**
 * DOM ladder panel.
 *
 * Price rungs centered on the mid, each rung showing bid size (left) and ask size
 * (right) with a horizontal size bar (teal bid / red ask) whose length ∝ size. The
 * data source is capability-driven and honest — the badge shows the real tier
 * and the panel never fabricates bid/ask it does not have:
 *
 * The badge (honesty tier) and the layout SHAPE are decoupled ({@link depthTier}
 * vs {@link ladderShape}): the badge names provenance, the shape follows the book
 * the feed sends.
 *
 *   - depth L2    → the real multi-level book: the newest DepthColumn's bid/ask
 *                   density arrays, rows→prices via the epoch geometry, the N rungs
 *                   around the mid. Best bid/ask rows highlighted. Badge `L2`.
 *   - depth L1    → keyed Alpaca top-of-book: a two-sided book (or the BBO as a
 *                   one-level ladder before the first book). Badge `L1`.
 *   - depth SYNTH → the two-sided synthetic volume-at-price depth (bid below / ask
 *                   above the reference price) renders as a real bid/ask book;
 *                   a legacy one-sided SYNTH_PROFILE mode still renders a centered
 *                   profile. Either way, badge `SYNTH` — honest provenance.
 *
 * A recorded-density replay keeps its real tier in the badge and shows a
 * `RECORDED DENSITY` provenance chip beside it.
 *
 * The sim and native crypto feeds badge `L2`; a ccxt-polled book badges
 * `L2-SNAPSHOT` (real, but re-read whole each tick, so it carries the caution
 * style). The sim feed emits NO BBO, so the mid and best bid/ask are DERIVED from
 * the book's density arrays; when a BBO is present
 * (crypto) it is preferred. Auto-scroll keeps the mid centered; a lock toggle
 * freezes the center so the user can read a level while the market moves.
 *
 * High-frequency updates come off the module-scoped {@link bookStore} at ~10 Hz
 * (NOT per column), so the panel stays off the React high-frequency path and never
 * fights the GL loop. Epoch geometry + capability are low-frequency store state.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { MODE_SYNTH_PROFILE, type EpochParams } from '../proto/types';
import { depthTier, isRecordedDensity, type DepthTier } from './DomLadderTier';
import { priceToRow, rowToPrice, scaleFromEpoch, stepAtRow, type PriceScale } from '../gl/priceScale';
import { bookSessionKey, type BookSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { formatPrice, formatSizeCompact } from '../i18n/format';
import { useT } from '../i18n/useT';
import { LadderHeader } from './DomLadderHeader';
import { ROW_H, clampRow, useBookSnapshot, useLockedWheel, useVisibleRowCount } from './DomLadderHooks';
import './TradingPanels.css';
import './DomLadder.css';

export { depthTier, isRecordedDensity, type DepthTier } from './DomLadderTier';

/** Density below this is treated as an empty book level (f16 residue floor). */
const DENSITY_EPS = 1e-6;

export interface LadderRowVM {
  row: number;
  price: number;
  bidSz: number;
  askSz: number;
  bidPct: number;
  askPct: number;
  profileSz: number;
  profilePct: number;
  isBestBid: boolean;
  isBestAsk: boolean;
}

export interface LadderModel {
  rows: LadderRowVM[];
  priceDecimals: number;
  /** Fractional mid row (live), or null when it cannot be derived. */
  midRow: number | null;
  /**
   * Best-ask − best-bid in price units, or null when only one side genuinely
   * exists (L1/one-sided) — never fabricated from a synthesized opposite side.
   */
  spread: number | null;
}

/**
 * How to LAY OUT the rungs — decoupled from the honesty {@link DepthTier} badge.
 * The badge names the data's provenance (`SYNTH` stays `SYNTH`); the shape is
 * driven by the book the feed actually sends:
 *   - `profile` — a one-sided density (legacy bid-only SYNTH_PROFILE mode):
 *     centered volume-at-price bars, no bid/ask split.
 *   - `l1`      — an L1 tier with a BBO: the two BBO rungs, others blank.
 *   - `book`    — any two-sided density (real L2, keyed L1 band, OR the new
 *     two-sided synthetic depth): per-row bid/ask from the density arrays.
 * So a two-sided synthetic book renders like a real book while still badged
 * `SYNTH` — honest provenance, honest shape, no fabricated levels.
 */
export type LadderShape = 'profile' | 'l1' | 'book';

export function ladderShape(tier: DepthTier | null, bookMode: number | null): LadderShape {
  if (bookMode === MODE_SYNTH_PROFILE) return 'profile';
  if (tier === 'L1' && bookMode === null) return 'l1';
  return 'book';
}

/**
 * Decimal places implied by the price step (tick·multiple). The old hard cap of
 * 8 printed `0.00000000` for sub-1e-8 prices (a 1e-9 quote is a real thing on
 * micro-cap chains) — the cap now grows with the magnitude, bounded defensively
 * so a pathological step cannot print an absurd fixed-point string.
 */
export function priceDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 2;
  for (let decimals = 0; decimals < 12; decimals++) {
    const scaled = step * 10 ** decimals;
    if (scaled >= 1 && Math.abs(scaled - Math.round(scaled)) < 1e-8) return decimals;
  }
  return 12;
}

/** Match NumPy rint in the server's depth binning, including half-to-even. */
export function depthBucket(row: number): number {
  const lo = Math.floor(row), fraction = row - lo;
  if (Math.abs(fraction - 0.5) <= 1e-7) return lo % 2 === 0 ? lo : lo + 1;
  return Math.round(row);
}

/**
 * Best bid/ask rows + fractional mid row. Prefers the BBO (crypto); else derives
 * from the book density arrays (the sim path): best bid = highest nonzero bid row,
 * best ask = lowest nonzero ask row. For a SYNTH profile (no ask) the center is the
 * point-of-control (max-density) row.
 */
function deriveQuotes(
  snap: BookSnapshot,
  params: EpochParams,
  shape: LadderShape,
): { bestBidRow: number; bestAskRow: number; midRow: number | null; spread: number | null } {
  const scale = scaleFromEpoch(params);
  const rows = params.rows;
  const bbo = snap.bbo;
  const currentBbo = bbo && (!snap.book?.recordedDensity || bbo.tsNs === snap.book.t0Ns) ? bbo : null;
  if (currentBbo && shape !== 'profile') {
    const bestBidRow = clampRow(depthBucket(priceToRow(scale, currentBbo.bidPx)), rows);
    const bestAskRow = clampRow(depthBucket(priceToRow(scale, currentBbo.askPx)), rows);
    const midRow = priceToRow(scale, (currentBbo.bidPx + currentBbo.askPx) / 2);
    // Both sides of a BBO are real — honest spread from the quoted prices.
    return { bestBidRow, bestAskRow, midRow, spread: currentBbo.askPx - currentBbo.bidPx };
  }
  const book = snap.book;
  if (book === null) return { bestBidRow: -1, bestAskRow: -1, midRow: null, spread: null };

  if (shape === 'profile') {
    // Point-of-control: the densest row of the volume-at-price profile.
    let pocRow = -1;
    let pocVal = DENSITY_EPS;
    for (let r = 0; r < book.bid.length; r += 1) {
      if (book.bid[r] > pocVal) {
        pocVal = book.bid[r];
        pocRow = r;
      }
    }
    return { bestBidRow: -1, bestAskRow: -1, midRow: pocRow >= 0 ? pocRow : null, spread: null };
  }

  let bestBidRow = -1;
  for (let r = book.bid.length - 1; r >= 0; r -= 1) {
    if (book.bid[r] > DENSITY_EPS) {
      bestBidRow = r;
      break;
    }
  }
  let bestAskRow = -1;
  const ask = book.ask;
  if (ask) {
    for (let r = 0; r < ask.length; r += 1) {
      if (ask[r] > DENSITY_EPS) {
        bestAskRow = r;
        break;
      }
    }
  }
  // Spread only when BOTH sides genuinely exist — never from a synthesized side.
  // Spread from the two rows' PRICES, not (rowΔ × step): on a non-uniform grid
  // a row's price width depends on where it sits, so scaling a row delta by a
  // single step would misreport the spread anywhere off the core.
  const spread =
    bestBidRow >= 0 && bestAskRow >= 0
      ? rowToPrice(scale, bestAskRow) - rowToPrice(scale, bestBidRow)
      : null;
  if (book.recordedDensity || (spread !== null && spread < 0)) {
    // Keep the occupied density centered and visible, without presenting its
    // overlapping extents as inside quotes or inventing an empty ask rung.
    const occupied = [bestBidRow, bestAskRow].filter(row => row >= 0);
    return { bestBidRow: -1, bestAskRow: -1,
      midRow: occupied.length ? occupied.reduce((sum, row) => sum + row, 0) / occupied.length : null,
      spread: null };
  }
  if (bestBidRow < 0 && bestAskRow < 0) {
    return { bestBidRow: -1, bestAskRow: -1, midRow: null, spread: null };
  }
  if (bestBidRow < 0) bestBidRow = bestAskRow - 1;
  if (bestAskRow < 0) bestAskRow = bestBidRow + 1;
  if (bestAskRow <= bestBidRow) bestAskRow = bestBidRow + 1;
  return { bestBidRow, bestAskRow, midRow: (bestBidRow + bestAskRow) / 2, spread };
}

/**
 * Top of book read straight from the depth book, the same best rungs the DOM
 * ladder highlights. The market strip uses it when no BBO frame has
 * arrived (sim, some recorded feeds), so its Bid/Ask/Spread agree with the
 * ladder instead of showing a dash beside a populated book. Unlike
 * {@link deriveQuotes} it never synthesises a missing side: it returns null
 * unless both sides are resting and the bid sits below the ask. Recorded
 * density and synthetic profiles carry no quotes, so they also return null.
 */
export function bookTopOfBook(
  snap: BookSnapshot,
  params: EpochParams | undefined,
): { bidPx: number; bidSz: number; askPx: number; askSz: number } | null {
  const book = snap.book;
  if (!params || !book || book.recordedDensity || !book.ask) return null;
  let bidRow = -1;
  for (let r = book.bid.length - 1; r >= 0; r -= 1) {
    if (book.bid[r] > DENSITY_EPS) {
      bidRow = r;
      break;
    }
  }
  let askRow = -1;
  for (let r = 0; r < book.ask.length; r += 1) {
    if (book.ask[r] > DENSITY_EPS) {
      askRow = r;
      break;
    }
  }
  if (bidRow < 0 || askRow < 0 || askRow <= bidRow) return null;
  const scale = scaleFromEpoch(params);
  return {
    bidPx: rowToPrice(scale, bidRow),
    bidSz: book.bid[bidRow],
    askPx: rowToPrice(scale, askRow),
    askSz: book.ask[askRow],
  };
}

/**
 * Pure ladder model for a snapshot. `centerOverride` (the locked center) pins the
 * window; when null the window auto-centers on the live mid. Returns `visRows`
 * rungs top-to-bottom (highest price first).
 */
export function buildLadder(
  snap: BookSnapshot,
  params: EpochParams | undefined,
  shape: LadderShape,
  visRows: number,
  centerOverride: number | null,
): LadderModel {
  const book = snap.book;
  // A live L1 tier can show its BBO before the first book column arrives — the
  // `l1` shape renders straight from `snap.bbo`, so a null book is fine there.
  const hasL1Bbo = !book && shape === 'l1' && snap.bbo !== null;
  if ((!book && !hasL1Bbo) || !params) {
    return { rows: [], priceDecimals: 2, midRow: null, spread: null };
  }

  const scale = scaleFromEpoch(params);
  const nrows = params.rows;
  const { bestBidRow, bestAskRow, midRow, spread } = deriveQuotes(snap, params, shape);

  const center = centerOverride ?? midRow ?? (nrows - 1) / 2;
  const centerInt = Math.round(center);
  // Quote/tape precision remains the venue precision, even in grouped depth.
  const decimals = priceDecimals(params.tick);
  const half = Math.floor(Math.max(1, visRows) / 2);

  const out: LadderRowVM[] = [];
  let maxSz = DENSITY_EPS;
  // First pass top→bottom, collecting sizes; scale bars in a second pass.
  for (let r = centerInt + half; r >= centerInt - half; r -= 1) {
    const inRange = r >= 0 && r < nrows;
    let bidSz = 0;
    let askSz = 0;
    let profileSz = 0;
    if (shape === 'profile') {
      profileSz = inRange && book ? book.bid[r] : 0;
    } else if (shape === 'l1') {
      if (snap.bbo && r === bestBidRow) bidSz = snap.bbo.bidSz;
      if (snap.bbo && r === bestAskRow) askSz = snap.bbo.askSz;
    } else {
      // book: real per-row density (L2, keyed L1 band, or two-sided synthetic).
      // `book` is only null for the `l1` shape above, so these branches are
      // unreachable then — the guard keeps the strict `tsc -b` build happy.
      bidSz = inRange && book ? book.bid[r] : 0;
      askSz = inRange && book && book.ask ? book.ask[r] : 0;
    }
    maxSz = Math.max(maxSz, bidSz, askSz, profileSz);
    out.push({
      row: r,
      price: rowToPrice(scale, r),
      bidSz,
      askSz,
      profileSz,
      bidPct: 0,
      askPct: 0,
      profilePct: 0,
      isBestBid: shape !== 'profile' && r === bestBidRow,
      isBestAsk: shape !== 'profile' && r === bestAskRow,
    });
  }
  // Fractional widths (no rounding) with a 2%-wide floor for any nonzero level,
  // so a sub-1% size never renders a visible number over a 0-width bar.
  for (const row of out) {
    row.bidPct = row.bidSz > 0 ? Math.max(2, (row.bidSz / maxSz) * 100) : 0;
    row.askPct = row.askSz > 0 ? Math.max(2, (row.askSz / maxSz) * 100) : 0;
    row.profilePct = row.profileSz > 0 ? Math.max(2, (row.profileSz / maxSz) * 100) : 0;
  }
  return { rows: out, priceDecimals: decimals, midRow, spread };
}

/**
 * Compact size formatting, shared with the crosshair and measure readouts via
 * i18n/format (rounds before choosing the suffix, so 999,960 reads `1M`, not
 * `1000K`; non-finite densities show an honest over-range glyph, never a number).
 */
export function fmtSz(v: number): string {
  return formatSizeCompact(v);
}

export function DomLadder(): JSX.Element {
  const t = useT();
  const capability = useFlowMapStore((s) => s.capability);
  const epochs = useFlowMapStore((s) => s.epochs);
  const gridEpoch = useFlowMapStore((s) => s.gridEpoch);
  const sessionKey = useFlowMapStore(bookSessionKey);
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const mode = useFlowMapStore((s) => s.subscription?.mode ?? 'live');
  const snap = useBookSnapshot();
  const [collapsed, setCollapsed] = useState(false);
  const [locked, setLocked] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [centerPrice, setCenterPrice] = useState<number | null>(null);
  const visRows = useVisibleRowCount(bodyRef, collapsed);

  const params = epochs.get(snap.book?.epoch ?? gridEpoch ?? -1);
  const bookMode = snap.book ? snap.book.mode : null;
  const tier = depthTier(capability, bookMode);
  const recorded = isRecordedDensity(capability);
  // A recorded interval keeps the book layout whatever its tier (as it always has).
  const shape = ladderShape(recorded ? null : tier, bookMode);
  const scale = useMemo(() => params ? scaleFromEpoch(params) : null, [params]);
  useLockedWheel({ bodyRef, collapsed, locked, scale, params, centerPrice, onCenterPrice: setCenterPrice });
  // The lock pins a PRICE, not a row: re-anchor to a row against the CURRENT
  // epoch each render, so a mid-stream p0/step change keeps the same price
  // centered instead of drifting to a stale row index.
  const centerOverride =
    locked && centerPrice !== null && scale !== null
      ? priceToRow(scale, centerPrice)
      : null;
  const model = useMemo(() => buildLadder(snap, params, shape, visRows, centerOverride),
    [snap, params, shape, visRows, centerOverride]);

  // The rendered window's center row is the middle of the returned rungs (the
  // window is always odd-length, centered on the mid or the locked row). The
  // spread separator's offset is measured from it, so it stays correct when a
  // lock pins the window away from the live mid.
  const centerRow =
    model.rows.length > 0 ? model.rows[Math.floor(model.rows.length / 2)].row : null;
  const midOffsetPx =
    model.midRow !== null && centerRow !== null ? -(model.midRow - centerRow) * ROW_H : null;

  // A session switch drops the pin; a grid re-anchor keeps its actual price.
  useEffect(() => {
    setLocked(false);
    setCenterPrice(null);
  }, [sessionKey]);

  const totals = useMemo(() => model.rows.reduce((sum, row) => ({
    bid: sum.bid + (Number.isFinite(row.bidSz) && row.bidSz > 0 ? row.bidSz : 0),
    ask: sum.ask + (Number.isFinite(row.askSz) && row.askSz > 0 ? row.askSz : 0),
  }), { bid: 0, ask: 0 }), [model.rows]);

  const badge = tier ?? 'N/A';
  // Class-safe token: `tier.toLowerCase()` yields 'l2'/'l1'/'synth' (and 'na'
  // for the no-data case) — never 'n/a', whose slash breaks the CSS selector.
  const badgeClass = tier ? tier.toLowerCase() : 'na';

  const spreadTicks =
    model.spread !== null && params && params.tick > 0
      ? Math.round(model.spread / params.tick)
      : null;
  const emptyMsg =
    feedState === 'closed'
      ? t('ladder.empty.closed')
      : status === 'reconnecting' || status === 'closed'
        ? t('ladder.empty.disconnected')
        : status === 'connecting'
          ? t('ladder.empty.connecting')
          : mode === 'replay'
            ? // Replay streams trades but no live book: "waiting for…" would
              // promise a book that is never coming.
              t('ladder.empty.replay')
            : t('ladder.empty.waiting');

  const toggleLock = (): void => {
    if (!locked && model.midRow !== null && scale) setCenterPrice(rowToPrice(scale, model.midRow));
    setLocked((v) => !v);
  };
  const centerOnMid = (): void => {
    setLocked(false);
    setCenterPrice(null);
  };

  return (
    <section
      className={`panel dom-ladder${collapsed ? ' is-collapsed' : ''}${
        tier === 'SYNTH' ? ' dom-ladder--synth' : ''
      }`}
      data-testid="dom-ladder"
    >
      <LadderHeader
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((c) => !c)}
        badge={badge}
        badgeClass={badgeClass}
        recorded={recorded}
        spread={spreadTicks !== null
          ? { price: formatPrice(model.spread!, model.priceDecimals), approximate: !snap.bbo, ticks: spreadTicks }
          : null}
        resolution={params && scale && model.midRow !== null
          ? formatPrice(stepAtRow(scale, Math.floor(model.midRow)), priceDecimals(params.tick))
          : null}
        locked={locked}
        midAvailable={model.midRow !== null}
        onToggleLock={toggleLock}
        onCenter={centerOnMid}
      />
      {!collapsed && (
        <LadderBody
          bodyRef={bodyRef}
          model={model}
          shape={shape}
          synth={tier === 'SYNTH'}
          recorded={recorded}
          locked={locked}
          scale={scale}
          midOffsetPx={midOffsetPx}
          totals={totals}
          emptyMsg={emptyMsg}
        />
      )}
    </section>
  );
}

interface LadderBodyProps {
  bodyRef: RefObject<HTMLDivElement>;
  model: LadderModel;
  shape: LadderShape;
  /** The honesty tier is SYNTH: no visible-sum summary for fabricated depth. */
  synth: boolean;
  recorded: boolean;
  locked: boolean;
  scale: PriceScale | null;
  midOffsetPx: number | null;
  totals: { bid: number; ask: number };
  emptyMsg: string;
}

/** The visible-sum summary and the rung list (or the empty message). */
function LadderBody({
  bodyRef,
  model,
  shape,
  synth,
  recorded,
  locked,
  scale,
  midOffsetPx,
  totals,
  emptyMsg,
}: LadderBodyProps) {
  const t = useT();
  return (
    <>
      {model.rows.length > 0 && !synth && shape !== 'profile' && (
        <div className="ladder__summary" data-testid="ladder-totals"
          title={t('ladder.totalsTitle')}>
          <span>{t('ladder.visibleSum')}</span><span className="ladder__total-bid">{t('ladder.bidShort')} {fmtSz(totals.bid) || '0'}</span>
          <span className="ladder__total-ask">{t('ladder.askShort')} {fmtSz(totals.ask) || '0'}</span>
          <span className="ladder__browse">{locked ? t('ladder.wheelBrowse')
            : recorded && model.spread === null ? t('ladder.followDensity') : t('ladder.followMid')}</span>
        </div>
      )}
      <div className="ladder__body" ref={bodyRef} data-testid="ladder-body">
        {model.rows.length === 0 ? (
          <div className="panel__empty">{emptyMsg}</div>
        ) : (
          <>
            {(shape === 'book' || shape === 'l1') && midOffsetPx !== null
              && (!recorded || model.spread !== null) && (
              <div
                className="ladder__mid"
                aria-hidden="true"
                data-testid="ladder-mid"
                style={{ top: `calc(50% + ${midOffsetPx.toFixed(1)}px)` }}
              />
            )}
            {model.rows.map((r) => (
              <LadderRowView
                key={r.row}
                r={r}
                shape={shape}
                priceDecimals={model.priceDecimals}
                scale={scale}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

interface LadderRowViewProps {
  r: LadderRowVM;
  shape: LadderShape;
  priceDecimals: number;
  scale: PriceScale | null;
}

/** One rung: the bid cell, the price, and the ask cell (a one-sided profile bar in profile mode). */
function LadderRowView({ r, shape, priceDecimals: decimals, scale }: LadderRowViewProps) {
  const t = useT();
  return (
    <div
      className={`ladder__row${r.isBestBid ? ' is-bestbid' : ''}${
        r.isBestAsk ? ' is-bestask' : ''
      }`}
      data-testid="ladder-row"
      data-row={r.row}
      data-price={formatPrice(r.price, decimals)}
      title={scale ? t('ladder.groupTitle', {
        low: formatPrice(rowToPrice(scale, r.row - 0.5), decimals),
        high: formatPrice(rowToPrice(scale, r.row + 0.5), decimals),
      }) : undefined}
      data-bid={r.bidSz.toFixed(4)}
      data-ask={r.askSz.toFixed(4)}
    >
      {shape === 'profile' ? (
        <div className="ladder__profile">
          <div
            className={`ladder__bar ladder__bar--profile${r.profilePct > 0 ? '' : ' is-empty'}`}
            style={{ width: `${r.profilePct}%` }}
          />
          <span className="ladder__sz">
            {fmtSz(r.profileSz)}
          </span>
        </div>
      ) : (
        <>
          <div className="ladder__cell ladder__cell--bid">
            <div
              className={`ladder__bar ladder__bar--bid${r.bidPct > 0 ? '' : ' is-empty'}`}
              style={{ width: `${r.bidPct}%` }}
            />
            <span className="app-visually-hidden">{t('ladder.bidFull')}</span>
            <span className="ladder__sz">
              {fmtSz(r.bidSz)}
            </span>
          </div>
          <div className="ladder__px">{formatPrice(r.price, decimals)}</div>
          <div className="ladder__cell ladder__cell--ask">
            <div
              className={`ladder__bar ladder__bar--ask${r.askPct > 0 ? '' : ' is-empty'}`}
              style={{ width: `${r.askPct}%` }}
            />
            <span className="app-visually-hidden">{t('ladder.askFull')}</span>
            <span className="ladder__sz">
              {fmtSz(r.askSz)}
            </span>
          </div>
        </>
      )}
      {shape === 'profile' && <div className="ladder__px ladder__px--synth">{formatPrice(r.price, decimals)}</div>}
    </div>
  );
}
