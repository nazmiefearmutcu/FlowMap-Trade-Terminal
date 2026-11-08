import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type { PriceFollow } from '../gl/camera';
import type { Renderer } from '../gl/renderer';
import { bookStore } from '../state/bookStore';
import { sessionResetKey, useFlowMapStore } from '../state/store';
import type { FlowMapSettings } from '../ui/settings';

/** The LIVE follow policies, kept apart from the replay camera's own state. */
export interface LiveFollow {
  time: boolean;
  price: PriceFollow;
}

/** How often the renderer's follow state is reconciled back into settings. */
export const FOLLOW_RECONCILE_MS = 250;

/**
 * Session identity bridge. A change of the subscription identity (symbol, mode,
 * band, replay window) or of the session revision resets the renderer and the
 * book; a new Hello on the same subscription resets only the overlays. Observed
 * synchronously: a Hello and its first snapshot can share one WS frame, before
 * React effects run.
 */
export function useSessionResetBridge(
  rendererRef: MutableRefObject<Renderer | null>,
  liveFollowRef: MutableRefObject<LiveFollow>,
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>,
): void {
  useEffect(() => {
    return useFlowMapStore.subscribe((state, previous) => {
      const identityChanged = sessionResetKey(state.subscription) !== sessionResetKey(previous.subscription)
        || state.sessionRevision !== previous.sessionRevision;
      const newHello = state.sessionId !== null && state.sessionId !== previous.sessionId;
      const replayGeneration = newHello && state.subscription?.mode === 'replay';
      if (identityChanged || replayGeneration) {
        const r = rendererRef.current;
        if (identityChanged && previous.subscription?.mode === 'live' && r) {
          // Canvas keys/gestures can change these just before the picker opens,
          // before the reconciliation timer. Capture BEFORE replacing them.
          liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
          const { time, price } = liveFollowRef.current;
          setSettings(prev => prev.follow === time && prev.followPrice === (price !== 'off')
            ? prev : { ...prev, follow: time, followPrice: price !== 'off' });
        }
        r?.setFollowTime(state.subscription?.mode === 'replay' ? true : liveFollowRef.current.time);
        r?.setPriceFollow(state.subscription?.mode === 'replay' ? 'fit' : liveFollowRef.current.price);
        rendererRef.current?.resetForSession();
        bookStore.resetForSession();
      } else if (newHello) {
        bookStore.resetForSession();
        rendererRef.current?.resetOverlaysForNewSession(state.sessionId ?? undefined);
      }
    });
  }, [rendererRef, liveFollowRef, setSettings]);
}

/**
 * Renderer → settings price-follow reconciliation. The chip and the global follow
 * keys write through App, but the chart canvas keys, a price pan's release, and a
 * gutter double-click mutate the camera directly. A ≤4 Hz value-diff persists the
 * PRICE axis policy whenever it changes underneath, so the drawer switch and the
 * next boot can never claim AUTO while the camera is LOCKed. TIME reconciles
 * wantedFollowTime, which keeps explicit intent while a pan detaches the camera.
 * Replay navigation never writes these persisted LIVE policies.
 */
export function useFollowReconcile(
  rendererRef: MutableRefObject<Renderer | null>,
  liveFollowRef: MutableRefObject<LiveFollow>,
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>,
): void {
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = rendererRef.current;
      if (!r) return;
      if (useFlowMapStore.getState().subscription?.mode === 'replay') return;
      liveFollowRef.current = { time: r.wantedFollowTime, price: r.priceFollow };
      const followPrice = r.priceFollow !== 'off';
      // Capture before React processes the updater: replay may replace the
      // renderer policies in the meantime.
      const follow = r.wantedFollowTime;
      setSettings((prev) => {
        return prev.followPrice === followPrice && prev.follow === follow
          ? prev
          : { ...prev, followPrice, follow };
      });
    }, FOLLOW_RECONCILE_MS);
    return () => window.clearInterval(id);
  }, [rendererRef, liveFollowRef, setSettings]);
}
