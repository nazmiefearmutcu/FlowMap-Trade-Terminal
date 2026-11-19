/**
 * The measure readout box (Δprice, Δtime, depth, endpoints) and its placement beside
 * the measured rectangle. MeasureTool.tsx decides when it shows; this only renders it.
 */

import type { CSSProperties, RefObject } from 'react';

import { formatPrice, formatSizeReadout } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { MeasureGeometry } from './MeasureToolState';

/** A measurement in container px: its anchor and its end. */
export interface MeasureRect {
  anchor: { x: number; y: number };
  end: { x: number; y: number };
}

/** Place the readout box beside the rectangle, flipping away from the near edges. */
export function boxStyle(containerRef: RefObject<HTMLElement | null>, rect: MeasureRect): CSSProperties {
  const w = containerRef.current?.clientWidth ?? 0;
  const h = containerRef.current?.clientHeight ?? 0;
  const left = Math.min(rect.anchor.x, rect.end.x);
  const right = Math.max(rect.anchor.x, rect.end.x);
  const top = Math.min(rect.anchor.y, rect.end.y);
  const bottom = Math.max(rect.anchor.y, rect.end.y);
  const flipX = w > 0 && right > w - 170;
  const flipY = h > 0 && bottom > h - 96;
  const clamp = (v: number, hi: number): number => Math.max(6, hi > 6 ? Math.min(hi, v) : v);
  return {
    ...(flipX
      ? { right: `${clamp(w - left + 10, w - 170)}px` }
      : { left: `${clamp(right + 10, w - 170)}px` }),
    ...(flipY
      ? { bottom: `${clamp(h - top + 10, h - 96)}px` }
      : { top: `${clamp(bottom + 10, h - 96)}px` }),
  };
}

type ReadoutFields = Pick<MeasureGeometry, 'deltaPriceText' | 'deltaTimeText' | 'depth' | 'isSynth' | 'startPx' | 'endPx'>;

interface MeasureReadoutProps extends ReadoutFields {
  style: CSSProperties;
}

/** The readout box: the price and time deltas, the depth in the band and the endpoint prices. */
export function MeasureReadout({
  style,
  deltaPriceText,
  deltaTimeText,
  depth,
  isSynth,
  startPx,
  endPx,
}: MeasureReadoutProps): JSX.Element {
  const t = useT();
  return (
    <div className="measure__box" data-testid="measure-readout" style={style}>
      <div className="measure__row">
        <span className="measure__k">{t('measure.deltaPrice')}</span>
        <span className="measure__v" data-testid="measure-dprice">
          {deltaPriceText}
        </span>
      </div>
      <div className="measure__row">
        <span className="measure__k">{t('measure.deltaTime')}</span>
        <span className="measure__v" data-testid="measure-dtime">
          {deltaTimeText}
        </span>
      </div>
      <div className="measure__row">
        <span className="measure__k">{isSynth ? t('measure.vol') : t('measure.depth')}</span>
        <span className="measure__v" data-testid="measure-ddepth">
          {depth === null ? (
            '—'
          ) : isSynth ? (
            formatSizeReadout(depth.bid)
          ) : (
            <>
              <span className="measure__bid">{formatSizeReadout(depth.bid)}</span>
              {' · '}
              <span className="measure__ask">
                {depth.ask === null ? '—' : formatSizeReadout(depth.ask)}
              </span>
            </>
          )}
        </span>
      </div>
      {startPx && endPx && (
        <div className="measure__row measure__row--dim" data-testid="measure-endpoints">
          <span className="measure__k">{t('measure.endpoints')}</span>
          <span className="measure__v">
            {formatPrice(startPx.price, startPx.decimals)} → {formatPrice(endPx.price, endPx.decimals)}
          </span>
        </div>
      )}
    </div>
  );
}
