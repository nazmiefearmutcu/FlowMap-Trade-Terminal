/**
 * PerfHud — the render-health chip.
 *
 * A tiny monospace HUD (bottom-left of the chart viewport) showing fps, frame
 * ms, texture uploads, draw calls and the column-cache footprint, read from
 * `renderer.stats()` (EMA-smoothed on the renderer side). Polled
 * at 2 Hz — NEVER per frame — and rendering an honest `—` per field while the
 * renderer provides no stats or before the first poll.
 *
 * `H` toggles visibility; the flag is workspace state, so the component takes
 * `visible` + `onToggle` props and App persists it in the settings store
 * (`hudVisible`). `stats()` is feature-detected off the renderer instance, so a
 * renderer without it shows the dashes.
 */

import { useEffect, useState, type MutableRefObject } from 'react';

import type { Renderer } from '../gl/renderer';
import { classifyTarget, routeGlobalKey } from '../input/keys';
import { formatFixed, formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import './features.css';

/** The renderer's `stats()` snapshot. Every value is an O(1) read. */
export interface RendererStats {
  fps: number;
  frameMs: number;
  uploads: number;
  draws: number;
  cacheBytes: number;
}

/** 2 Hz poll — cheap enough to be invisible, fast enough for readable numbers. */
const POLL_MS = 500;

function readStats(renderer: Renderer | null): RendererStats | null {
  if (renderer === null) return null;
  try {
    return renderer.stats();
  } catch {
    // A failed read shows the dashes rather than a stale or partial snapshot.
    return null;
  }
}

function fmt1(v: number | null, dash = '—'): string {
  return v === null || !Number.isFinite(v) ? dash : formatFixed(v, 1);
}

function fmtInt(v: number | null, dash = '—'): string {
  return v === null || !Number.isFinite(v) ? dash : formatNumber(Math.round(v));
}

function fmtMb(bytes: number | null, megabyte: string, dash = '—'): string {
  if (bytes === null || !Number.isFinite(bytes)) return dash;
  return `${formatFixed(bytes / 1_048_576, 0)}${megabyte}`;
}

interface PerfHudProps {
  rendererRef: MutableRefObject<Renderer | null>;
  /** Whether the chip is shown (settings `hudVisible`; H toggles via onToggle). */
  visible: boolean;
  /** Toggle callback — App patches settings so the choice persists. */
  onToggle: () => void;
}

export function PerfHud({ rendererRef, visible, onToggle }: PerfHudProps): JSX.Element | null {
  const [stats, setStats] = useState<RendererStats | null>(null);
  const t = useT();

  // `H` — toggle the chip. Routed through the shared router so the
  // editable/dialog guards live in exactly one place (input/keys.ts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Holding H must not flicker the chip on and off at the key repeat rate.
      if (e.repeat) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'toggle-hud') return;
      e.preventDefault();
      onToggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggle]);

  // 2 Hz poll of the renderer's O(1) stats snapshot.
  useEffect(() => {
    if (!visible) return;
    const tick = (): void => setStats(readStats(rendererRef.current));
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [visible, rendererRef]);

  if (!visible) return null;
  const dash = '—';

  return (
    // A named group, not a live region: the values refresh at 2 Hz, and a polite
    // status region would announce every refresh to a screen reader user.
    <div className="perfhud" data-testid="perf-hud" role="group" aria-label={t('perfHud.aria')}>
      <span className="perfhud__cell">
        <span className="perfhud__k">{t('perfHud.fps')}</span>
        <span className="perfhud__v" data-testid="perfhud-fps">
          {stats ? fmt1(stats.fps) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">{t('perfHud.frame')}</span>
        <span className="perfhud__v" data-testid="perfhud-frame">
          {stats ? `${fmt1(stats.frameMs)}${t('unit.ms')}` : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">{t('perfHud.uploads')}</span>
        <span className="perfhud__v" data-testid="perfhud-uploads">
          {stats ? fmtInt(stats.uploads) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">{t('perfHud.draws')}</span>
        <span className="perfhud__v" data-testid="perfhud-draws">
          {stats ? fmtInt(stats.draws) : dash}
        </span>
      </span>
      <span className="perfhud__cell">
        <span className="perfhud__k">{t('perfHud.cache')}</span>
        <span className="perfhud__v" data-testid="perfhud-cache">
          {stats ? fmtMb(stats.cacheBytes, t('unit.mb')) : dash}
        </span>
      </span>
    </div>
  );
}
