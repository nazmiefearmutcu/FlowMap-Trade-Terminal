/**
 * The DOM ladder's React hooks: the throttled book snapshot, the rung count that
 * fits the panel height, and the wheel browse while the ladder is locked. The
 * panel component reads them; the geometry they share lives here too.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import type { EpochParams } from '../proto/types';
import type { PriceScale } from '../gl/priceScale';
import { priceToRow, rowToPrice } from '../gl/priceScale';
import { subscribe, getSnapshot, type BookSnapshot } from '../state/bookStore';

/** Row height in CSS px — must match `.ladder__row` height in App.css. */
export const ROW_H = 17;
const DEFAULT_LADDER_ROWS = 21;

/** Clamp a fractional row into `[0, rows - 1]`; -1 is the "no such row" sentinel. */
export function clampRow(r: number, rows: number): number {
  // NaN guard FIRST: priceToRow returns NaN for a non-positive price on a
  // non-uniform (log-winged) grid, and `NaN < 0` / `NaN > rows-1` are both
  // false — so an unguarded clamp would return NaN and quietly poison every
  // downstream row comparison. -1 is the established "no such row" sentinel.
  if (!Number.isFinite(r)) return -1;
  if (r < 0) return 0;
  if (r > rows - 1) return rows - 1;
  return r;
}

/**
 * The book snapshot the ladder renders. Trade-only flushes keep the same book and
 * BBO objects, so the ladder keeps its previous snapshot and skips the rebuild. A
 * session reset still propagates through sessionVersion / sessionKey (mirrors the
 * Tape guard).
 */
export function useBookSnapshot(): BookSnapshot {
  const [snap, setSnap] = useState<BookSnapshot>(() => getSnapshot());
  useEffect(
    () =>
      subscribe((s) =>
        setSnap((prev) =>
          prev.book === s.book &&
          prev.bbo === s.bbo &&
          prev.sessionKey === s.sessionKey &&
          prev.sessionVersion === s.sessionVersion
            ? prev
            : s,
        ),
      ),
    [],
  );
  return snap;
}

/** Fit the number of rungs to the panel height (odd, so the mid sits centered). */
export function useVisibleRowCount(bodyRef: RefObject<HTMLDivElement>, collapsed: boolean): number {
  const [visRows, setVisRows] = useState(DEFAULT_LADDER_ROWS);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const n = Math.floor(el.clientHeight / ROW_H);
      if (n >= 3) setVisRows(n % 2 === 0 ? n - 1 : n);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bodyRef, collapsed]);
  return visRows;
}

export interface LockedWheelOptions {
  bodyRef: RefObject<HTMLDivElement>;
  collapsed: boolean;
  locked: boolean;
  scale: PriceScale | null;
  params: EpochParams | undefined;
  centerPrice: number | null;
  onCenterPrice: (price: number) => void;
}

/**
 * While the ladder is locked, the wheel browses the pinned price up or down by
 * rungs (a pixel delta counts as rows of {@link ROW_H}). Unlocked, the wheel scrolls
 * the page as usual.
 */
export function useLockedWheel({
  bodyRef,
  collapsed,
  locked,
  scale,
  params,
  centerPrice,
  onCenterPrice,
}: LockedWheelOptions): void {
  // The listener is attached once per body element and reads the latest state
  // through this ref, so a re-render never re-binds it.
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});

  useLayoutEffect(() => {
    wheelHandlerRef.current = (e: WheelEvent): void => {
      if (!locked || !scale || !params || centerPrice === null || e.deltaY === 0) return;
      e.preventDefault();
      const amount = e.deltaMode === 1 ? Math.abs(e.deltaY) : Math.abs(e.deltaY) / ROW_H;
      const rungs = Math.max(1, Math.min(12, Math.round(amount)));
      const row = clampRow(priceToRow(scale, centerPrice) - Math.sign(e.deltaY) * rungs, params.rows);
      if (row >= 0) onCenterPrice(rowToPrice(scale, row));
    };
  }, [locked, scale, params, centerPrice, onCenterPrice]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent): void => wheelHandlerRef.current(event);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bodyRef, collapsed]);
}
