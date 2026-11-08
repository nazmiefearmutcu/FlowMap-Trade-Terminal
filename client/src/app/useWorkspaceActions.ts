import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';

import type { Renderer } from '../gl/renderer';
import type { StreamMode } from '../proto/types';
import { safeLocalStorage } from '../state/safeStorage';
import { useFlowMapStore } from '../state/store';
import type { FlowMapSettings } from '../ui/settings';
import { saveStartupSymbol } from '../ui/startupSymbol';

/** The instrument the replay range picker is open for. */
export interface ReplayTarget {
  market: string;
  symbol: string;
  band: string;
}

export interface WorkspaceActions {
  /** Non-null while the replay range picker is open. */
  replayPicker: ReplayTarget | null;
  closeReplayPicker: () => void;
  /** Apply a settings patch. In replay the follow flags drive the replay camera. */
  applyPatch: (patch: Partial<FlowMapSettings>) => void;
  onSelectSymbol: (market: string, symbol: string) => void;
  onSetMode: (mode: StreamMode) => void;
  onReplayConfirm: (startNs: bigint, endNs: bigint) => void;
}

/**
 * The symbol, mode and replay actions the top bar, the watchlist, the desk
 * toolbar and the drawers call. Each one acts on the stream the app already owns.
 */
export function useWorkspaceActions(
  rendererRef: { readonly current: Renderer | null },
  settingsRef: { readonly current: FlowMapSettings },
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>,
): WorkspaceActions {
  const [replayPicker, setReplayPicker] = useState<ReplayTarget | null>(null);

  const applyPatch = useCallback((patch: Partial<FlowMapSettings>) => {
    if (useFlowMapStore.getState().subscription?.mode === 'replay') {
      const { follow, followPrice, ...shared } = patch;
      if (follow !== undefined) rendererRef.current?.setFollowTime(follow);
      if (followPrice !== undefined) rendererRef.current?.setPriceFollow(followPrice ? 'track' : 'off');
      setSettings((prev) => ({ ...prev, ...shared }));
      return;
    }
    setSettings((prev) => ({ ...prev, ...patch }));
  }, [rendererRef, setSettings]);

  const onSelectSymbol = useCallback((market: string, symbol: string) => {
    saveStartupSymbol(safeLocalStorage(), market, symbol);
    const mode = useFlowMapStore.getState().subscription?.mode ?? 'live';
    // The band MUST ride along: without it a symbol switch silently reverts the
    // server grid to `native` while the drawer keeps showing the chosen preset.
    useFlowMapStore
      .getState()
      .connectAndSubscribe(market, symbol, mode, settingsRef.current.priceBand);
  }, [settingsRef]);

  const onSetMode = useCallback((mode: StreamMode) => {
    const sub = useFlowMapStore.getState().subscription;
    // A mode toggle acts on the stream the app already owns. With no subscription
    // there is nothing to switch, so it must not invent one.
    if (!sub) return;
    if (mode === 'replay') {
      setReplayPicker({ market: sub.market, symbol: sub.symbol, band: sub.band });
      return;
    }
    // A mode toggle is a MODE change on the CURRENT grid, so the band rides along
    // from the subscription, never from the drawer default: the deep band's
    // auto-fit frames the whole ±50% band, which pancakes the scale.
    useFlowMapStore.getState().connectAndSubscribe(sub.market, sub.symbol, mode, sub.band);
  }, []);

  const onReplayConfirm = useCallback((startNs: bigint, endNs: bigint): void => {
    if (!replayPicker) return;
    const state = useFlowMapStore.getState();
    const sub = state.subscription;
    if (sub?.mode === 'replay' && sub.market === replayPicker.market && sub.symbol === replayPicker.symbol
      && sub.startNs === startNs && sub.endNs === endNs) {
      state.pause(); state.setSpeed(1); state.seek(state.replayPlayback?.startNs ?? startNs);
    } else {
      state.connectAndSubscribe(replayPicker.market, replayPicker.symbol, 'replay', replayPicker.band, { startNs, endNs });
    }
    setReplayPicker(null);
  }, [replayPicker]);

  const closeReplayPicker = useCallback(() => setReplayPicker(null), []);

  return { replayPicker, closeReplayPicker, applyPatch, onSelectSymbol, onSetMode, onReplayConfirm };
}
