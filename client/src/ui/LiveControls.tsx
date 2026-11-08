/**
 * In-chart live/follow affordance (transport).
 *
 * A small popup that surfaces INSIDE the chart (bottom-centre of the viewport)
 * only when a follow axis is off, so the user always sees how to get back to live
 * without hunting for the footer GO LIVE button (which sits outside the chart and
 * is easy to miss). Two independent chips:
 *
 *   - GO LIVE  — shown when time-follow is off (the view trails the live edge);
 *     re-pins the right edge and re-arms follow via the App's onGoLive.
 *   - TRACK PRICE — shown when the price axis is locked; re-enables price tracking
 *     as 'track' (KEEPS the user's zoom, only recentres) — never 'fit', so it does
 *     not destroy the scale the user set. When the live edge is off-screen the
 *     App's composite ALSO re-pins time (see App.onTrackPrice) — the tooltip
 *     says so, so the click is never a silent surprise.
 *
 * Replay chrome: in `replay` mode these
 * chips are HIDDEN entirely. "GO LIVE" is meaningless against a replay head and
 * contradicts the transport pill, and "TRACK PRICE" alone cannot express the
 * replay-specific return-to-head action — the Timeline transport owns replay
 * navigation. Hiding (not disabling) keeps the surface honest: no affordance
 * that claims something it cannot do.
 *
 * It runs its own light ≤4 Hz poll of the renderer (following + priceFollow +
 * live-edge visibility + behind readout); nothing here goes into the per-frame
 * render path.
 */

import { useEffect, useState, type RefObject } from 'react';

import { useT } from '../i18n/useT';
import { colsBehind } from '../gl/follow';
import type { Renderer } from '../gl/renderer';
import type { StreamMode } from '../proto/types';
import { behindNs, formatDurationCoarseNs } from './replay';

const POLL_MS = 250;

interface LiveControlsProps {
  rendererRef: RefObject<Renderer | null>;
  onGoLive: () => void;
  onTrackPrice: () => void;
  /** Current stream mode; the chips are a LIVE-mode affordance only. */
  mode?: StreamMode;
}

export function LiveControls({
  rendererRef,
  onGoLive,
  onTrackPrice,
  mode = 'live',
}: LiveControlsProps): JSX.Element | null {
  const t = useT();
  const [following, setFollowing] = useState(true);
  const [priceLocked, setPriceLocked] = useState(false);
  const [edgeVisible, setEdgeVisible] = useState(true);
  const [behind, setBehind] = useState('');

  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      setFollowing((f) => (f === r.following ? f : r.following));
      setPriceLocked((p) => {
        const locked = r.priceFollow === 'off';
        return p === locked ? p : locked;
      });
      const edge = r.liveEdgeVisible;
      setEdgeVisible((e) => (e === edge ? e : edge));
      const tl = r.timeline();
      let next = '';
      if (tl && tl.timeBase) {
        // Whole-column lag only (see Timeline's poll): the eased draw edge's
        // sub-column glide lag (gl/renderer stepLiveEdgeGlide) is not history
        // lag and must not read as one.
        const lag = colsBehind(
          { colOffset: tl.viewStartCol, colScale: tl.viewEndCol - tl.viewStartCol, rowOffset: 0, rowScale: 1 },
          tl.newestSeq,
        );
        const behindCols = !r.following && lag >= 1 ? lag : 0;
        if (behindCols > 0 && tl.timeBase.dtNs > 0)
          next = formatDurationCoarseNs(behindNs(behindCols, tl.timeBase.dtNs));
      }
      setBehind((b) => (b === next ? b : next));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [rendererRef]);

  if (mode === 'replay') return null;
  if (following && !priceLocked) return null;

  return (
    <div className="livectl" data-testid="live-controls">
      {!following && (
        <button
          type="button"
          className="livectl__chip livectl__chip--live"
          data-testid="chip-go-live"
          onClick={onGoLive}
          title={t('livectl.goLiveHint')}
        >
          <span className="livectl__dot" aria-hidden="true" />
          {t('transport.goLive')}{behind ? ` · −${behind}` : ''}
        </button>
      )}
      {priceLocked && (
        <button
          type="button"
          className="livectl__chip"
          data-testid="chip-track-price"
          onClick={onTrackPrice}
          title={edgeVisible ? t('livectl.trackHint') : t('livectl.trackHintEdge')}
        >
          {t('livectl.trackPrice')}
        </button>
      )}
    </div>
  );
}
