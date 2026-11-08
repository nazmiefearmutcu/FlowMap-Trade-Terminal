import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';
import { useFlowMapStore } from '../state/store';
import type { FlowMapSettings } from '../ui/settings';

/** The follow-policy writers App hands to the chart controls and the global keys. */
export interface FollowControls {
  onGoLive: () => void;
  onTrackPrice: () => void;
  onSetPriceFollow: (mode: PriceFollow) => void;
  onToggleFollowKey: () => void;
  onTogglePriceFollowKey: () => void;
  onPriceAutoFitKey: () => void;
}

/**
 * The follow-policy writers. Each one drives the renderer and persists the LIVE
 * follow policy, so the drawer switches, the chip, the global keys and the next
 * boot agree with the camera. Replay actions drive the camera but never write the
 * live policy.
 */
export function useFollowControls(
  rendererRef: MutableRefObject<Renderer | null>,
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>,
): FollowControls {
  // GO LIVE routes through App (not straight to the renderer) so it also re-arms
  // the PERSISTED follow flags. Without that, a user who scrolled back would find
  // the drawer's follow switches still reading ON while the camera was frozen.
  const onGoLive = useCallback(() => {
    const r = rendererRef.current;
    r?.goLive();
    // A replay action must not write the LIVE follow policy.
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    // GO LIVE re-pins TIME and must PRESERVE a deliberate price LOCK: persist the
    // renderer's post-goLive price mode instead of forcing tracking back on.
    const priceOn = r?.priceFollow !== 'off';
    setSettings((prev) =>
      prev.follow && prev.followPrice === priceOn
        ? prev
        : { ...prev, follow: true, followPrice: priceOn },
    );
  }, [rendererRef, setSettings]);

  // Re-enable price tracking WITHOUT re-fitting: 'track' keeps the user's zoom
  // and only recentres on drift (the non-destructive counterpart to GO LIVE).
  //
  // While the live edge is off-screen, `setPriceFollow` is gated on the newest
  // column being visible, so flipping the mode alone would be a silent no-op. When
  // the renderer reports the edge hidden, the click ALSO re-pins TIME via goLive()
  // — which keeps the deliberate price lock and the user's zoom — so tracking can
  // actually act. Both follow policies are persisted.
  const onTrackPrice = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setPriceFollow('track');
    const repin = r.liveEdgeVisible === false;
    if (repin) r.goLive();
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    setSettings((prev) => {
      const follow = repin ? true : prev.follow;
      if (prev.followPrice && prev.follow === follow) return prev;
      return { ...prev, followPrice: true, follow };
    });
  }, [rendererRef, setSettings]);

  // ONE writer for chip / global keys / drawer toggles. It applies the mode to the
  // renderer AND persists `followPrice`, so the drawer switch and the next boot
  // can never disagree with the camera.
  const onSetPriceFollow = useCallback((mode: PriceFollow) => {
    rendererRef.current?.setPriceFollow(mode);
    if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
    setSettings((prev) => {
      const followPrice = mode !== 'off';
      return prev.followPrice === followPrice ? prev : { ...prev, followPrice };
    });
  }, [rendererRef, setSettings]);

  // `F` (global): toggle TIME follow like the canvas key. The persisted policy is
  // written only in live mode — a replay camera's attach state has no bearing on
  // the live-follow policy the drawer switch stores.
  const onToggleFollowKey = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.toggleFollow();
    if (useFlowMapStore.getState().subscription?.mode !== 'replay') {
      setSettings((prev) => (prev.follow === r.following ? prev : { ...prev, follow: r.following }));
    }
  }, [rendererRef, setSettings]);

  // `P` (global): toggle the price axis off ↔ track. Reuse the one writer so the
  // persistence semantics match the chip exactly.
  const onTogglePriceFollowKey = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    onSetPriceFollow(r.priceFollow === 'off' ? 'track' : 'off');
  }, [rendererRef, onSetPriceFollow]);

  // `Shift+P` (global): restore price AUTO-FIT (same as a gutter double-click).
  const onPriceAutoFitKey = useCallback(() => {
    onSetPriceFollow('fit');
  }, [onSetPriceFollow]);

  return { onGoLive, onTrackPrice, onSetPriceFollow, onToggleFollowKey, onTogglePriceFollowKey, onPriceAutoFitKey };
}
