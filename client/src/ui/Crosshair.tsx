/**
 * Crosshair liquidity readout.
 *
 * A pointer-events-none overlay over the GL canvas: on pointer-move it maps the
 * cursor back through the camera inverse to a `(col_seq, row)` cell (via the
 * renderer's {@link Renderer.probeAt}, which reads the EXACT CPU column cache —
 * never the GPU/mip texels) and draws a thin crosshair line pair plus a compact
 * monospace readout box: session time, price (from the epoch's row→price
 * mapping), and the exact summed bid/ask resting size at that cell. Over a cell
 * with no cached data (deep history not fetched) it shows the price but "—" for
 * size. Trading-terminal look — thin lines, near-black box (see Crosshair.css).
 *
 * It attaches its OWN passive `pointermove` listener to the canvas (it does not
 * wrap or capture the pointer), so the pan/zoom gestures on the same canvas
 * are untouched. Probes are rAF-coalesced (≤ one per frame) so fast mouse motion
 * never storms React.
 */

import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from 'react';

import type { CrosshairReadout, Renderer } from '../gl/renderer';
import { getSnapshot } from '../state/bookStore';
import { useFlowMapStore } from '../state/store';
import { exchangeZoneFor, formatClock, formatFixed, formatPrice, formatSizeReadout, useTimeZone, zoneLabel, type TimeZonePref } from '../i18n/format';
import { useT } from '../i18n/useT';
import { clearProbeSpot, recordProbeSpot } from './lastProbe';
import { depthIsSynthetic, depthReadoutTier } from './heatLegendModel';
import { marketGroup } from './symbols';
import { fmtClockMs } from '../gl/overlays/axisTicks';
import './Crosshair.css';

interface CrosshairProps {
  canvasRef: RefObject<HTMLCanvasElement>;
  rendererRef: MutableRefObject<Renderer | null>;
}

interface HoverState {
  x: number;
  y: number;
  readout: CrosshairReadout | null;
}

const READOUT_KEYS: (keyof CrosshairReadout)[] = ['colSeq', 'row', 'group', 'price', 'priceLo', 'priceHi', 'priceDecimals', 'bid', 'ask', 'timeNs', 'averageMs', 'inRange'];
function sameReadout(a: CrosshairReadout | null, b: CrosshairReadout | null): boolean {
  return a === b || (a !== null && b !== null && READOUT_KEYS.every(key => Object.is(a[key], b[key])));
}

function fmtPrice(r: CrosshairReadout): string {
  return r.price === null ? '—' : formatPrice(r.price, r.priceDecimals);
}

/**
 * The grouped cell's true price EXTENT, e.g. ` 59488.0–59490.0`.
 *
 * A group of N covers N ROWS, and on a non-uniform price grid that is not
 * `N × step` of price — in the log wings one row can be worth hundreds of ticks.
 * Printing just `N×` there would imply a uniform width the grid does not have,
 * so the real span is shown alongside it. Empty when the extent is unknown or
 * the grid is uniform enough that the span is exactly the obvious one.
 */
function fmtBand(r: CrosshairReadout): string {
  if (r.priceLo === null || r.priceHi === null) return '';
  const d = r.priceDecimals;
  return `  ${formatPrice(r.priceLo, d)}–${formatPrice(r.priceHi, d)}`;
}

/**
 * ns → HH:MM:SS.mmm plus the zone label of the active time-zone preference
 * (local, UTC or the instrument's exchange zone). Pure: the caller supplies the
 * preference, so the readout re-renders when the Settings zone changes.
 *
 * A session-relative sim timestamp is not wall time: it reads the same T+ clock
 * the time axis and the tape use, with no zone label and no conversion.
 */
export function fmtTime(ns: bigint | null, pref: TimeZonePref = 'utc', exchangeZone = 'UTC', sessionRelative = false): string {
  if (ns === null) return '—';
  if (sessionRelative) return fmtClockMs(ns);
  const ms = Number(ns / 1_000_000n);
  if (!Number.isFinite(ms)) return '—';
  return `${formatClock(ms, pref, exchangeZone, true)} ${zoneLabel(pref, exchangeZone, ms)}`;
}

export function Crosshair({ canvasRef, rendererRef }: CrosshairProps): JSX.Element | null {
  const [hover, setHover] = useState<HoverState | null>(null);
  const capability = useFlowMapStore((s) => s.capability);
  const market = useFlowMapStore((s) => s.subscription?.market ?? '');
  const zonePref = useTimeZone();
  const t = useT();
  const group = marketGroup(market);
  const exchangeZone = exchangeZoneFor(group);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let pointer: { x: number; y: number } | null = null;
    // While the pointer is still, the camera and data move underneath it, so the
    // readout is re-read about ten times a second. Re-reading every frame (60/s)
    // with a motionless cursor was constant CPU work for no visible change.
    const REPROBE_MS = 100;
    let reprobeTimer = 0;
    const clearReprobe = (): void => {
      if (reprobeTimer) window.clearTimeout(reprobeTimer);
      reprobeTimer = 0;
    };
    const probe = (): void => {
        rafRef.current = 0;
        if (!pointer) return;
        const { x, y } = pointer;
        const renderer = rendererRef.current;
        const readout = renderer ? renderer.probeAt(x, y) : null;
        // Share the probe (price under the cursor) with feature components —
        // the `A` alert key anchors at exactly this price. Cheap, off-render.
        recordProbeSpot({
          price: readout?.price ?? null,
          priceDecimals: readout?.priceDecimals ?? 2,
          x,
          y,
          at: Date.now(),
        });
        setHover(prev => prev && prev.x === x && prev.y === y && sameReadout(prev.readout, readout) ? prev : { x, y, readout });
        // Only changed readouts commit a React render. The next probe is due in
        // REPROBE_MS, not on the next frame.
        reprobeTimer = window.setTimeout(() => {
          reprobeTimer = 0;
          if (pointer && !rafRef.current) rafRef.current = requestAnimationFrame(probe);
        }, REPROBE_MS);
    };
    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // A moving pointer probes immediately; the throttle only governs stillness.
      clearReprobe();
      if (!rafRef.current) rafRef.current = requestAnimationFrame(probe);
    };
    const onLeave = (): void => {
      pointer = null;
      // The A alert key must not anchor on the price left behind by a pointer that
      // has already gone.
      clearProbeSpot();
      clearReprobe();
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      setHover(null);
    };

    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    return () => {
      pointer = null;
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      clearReprobe();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [canvasRef, rendererRef]);

  if (!hover) return null;
  const { x, y, readout } = hover;

  // Depth-source provenance for the readout header. SYNTH must never read as real:
  // its size values are marked amber alongside the SYNTH tag. The verdict matches
  // the renderer's ramp, so a replayed synthetic recording is SYNTH here too.
  const bookMode = getSnapshot().book?.mode ?? null;
  const isSynth = depthIsSynthetic(capability, bookMode);
  const tier = depthReadoutTier(capability, bookMode);
  const recorded = capability?.depth_provenance === 'recorded-density';
  const sizeSynthCls = isSynth ? ' crosshair__val--synth' : '';

  // Place the readout box near the cursor, flipping away from the near edge.
  const canvas = canvasRef.current;
  const cw = canvas?.clientWidth ?? 0;
  const ch = canvas?.clientHeight ?? 0;
  const flipX = x > cw - 180;
  const flipY = y > ch - 110;
  const boxStyle: React.CSSProperties = {
    left: flipX ? undefined : `${x + 14}px`,
    right: flipX ? `${cw - x + 14}px` : undefined,
    top: flipY ? undefined : `${y + 14}px`,
    bottom: flipY ? `${ch - y + 14}px` : undefined,
  };

  return (
    <div className="crosshair" aria-hidden="true">
      <div className="crosshair__vline" style={{ left: `${x}px` }} />
      <div className="crosshair__hline" style={{ top: `${y}px` }} />
      {readout && (
        <div className="crosshair__box" data-testid="crosshair-readout" style={boxStyle}>
          {tier && (
            <div className="crosshair__line crosshair__line--head">
              <span className="crosshair__key">{t('crosshair.src')}</span>
              <span
                className={`crosshair__tag${isSynth ? ' crosshair__tag--synth' : ''}`}
                data-testid="crosshair-src"
                title={isSynth && recorded ? t('depthChip.recorded') : undefined}
              >
                {tier}
              </span>
            </div>
          )}
          <div className="crosshair__line">
            <span className="crosshair__key">{t('crosshair.time')}</span>
            <span className="crosshair__val" data-testid="crosshair-time">
              {fmtTime(readout.timeNs, zonePref, exchangeZone, group === 'sim')}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key">px</span>
            <span className="crosshair__val crosshair__val--price" data-testid="crosshair-price">
              {fmtPrice(readout)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key crosshair__key--bid">{t('crosshair.bid')}</span>
            <span
              className={`crosshair__val crosshair__val--bid${sizeSynthCls}`}
              data-testid="crosshair-bid"
            >
              {formatSizeReadout(readout.bid)}
            </span>
          </div>
          <div className="crosshair__line">
            <span className="crosshair__key crosshair__key--ask">{t('crosshair.ask')}</span>
            <span
              className={`crosshair__val crosshair__val--ask${sizeSynthCls}`}
              data-testid="crosshair-ask"
            >
              {formatSizeReadout(readout.ask)}
            </span>
          </div>
          {readout.group > 1 && (
            <div className="crosshair__line crosshair__line--dim">
              <span className="crosshair__key">{t('crosshair.group')}</span>
              <span className="crosshair__val" data-testid="crosshair-group">
                {readout.group}×{fmtBand(readout)}
              </span>
            </div>
          )}
          {readout.averageMs !== undefined && <div className="crosshair__line crosshair__line--dim">
            <span className="crosshair__key">{t('crosshair.average')}</span><span className="crosshair__val">{formatFixed(readout.averageMs / 1000, 1)} {t('unit.s')}</span>
          </div>}
        </div>
      )}
    </div>
  );
}
