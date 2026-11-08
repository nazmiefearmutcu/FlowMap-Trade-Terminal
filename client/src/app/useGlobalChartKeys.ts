import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { Renderer } from '../gl/renderer';
import { attachGlobalKeys } from '../input/keys';
import { useFlowMapStore } from '../state/store';
import type { FlowMapSettings } from '../ui/settings';
import type { SymbolSearchHandle } from '../ui/SymbolSearch';
import type { FollowControls } from './useFollowControls';

export interface GlobalChartKeysDeps {
  rendererRef: { readonly current: Renderer | null };
  searchRef: RefObject<SymbolSearchHandle>;
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>;
  exportPng: () => void;
  follow: Pick<FollowControls, 'onGoLive' | 'onToggleFollowKey' | 'onTogglePriceFollowKey' | 'onPriceAutoFitKey'>;
  toggleIntelDrawer: () => void;
}

/**
 * The bare-key workspace shortcuts (Space, `/`, `E`, F, P, Shift+P, R, J), bound
 * once on the window. Declared after the handlers it routes to: every dependency
 * is stable, so the binder attaches exactly once.
 */
export function useGlobalChartKeys({
  rendererRef, searchRef, setSettings, exportPng, follow, toggleIntelDrawer,
}: GlobalChartKeysDeps): void {
  const { onGoLive, onToggleFollowKey, onTogglePriceFollowKey, onPriceAutoFitKey } = follow;
  useEffect(() => {
    return attachGlobalKeys({
      onSpace: () => {
        const s = useFlowMapStore.getState();
        if (s.subscription?.mode === 'replay') {
          if (s.paused) s.resume();
          else s.pause();
        } else {
          const r = rendererRef.current;
          r?.toggleFollow();
          // Space is a settings-writable global path — persist the policy it just
          // set, so the drawer switch (and the next boot) agree with the camera.
          if (r) {
            setSettings((prev) =>
              prev.follow === r.following ? prev : { ...prev, follow: r.following },
            );
          }
        }
      },
      onFocusSearch: () => searchRef.current?.focus(),
      onExportPng: exportPng,
      onToggleFollow: onToggleFollowKey,
      onTogglePriceFollow: onTogglePriceFollowKey,
      onPriceAutoFit: onPriceAutoFitKey,
      onGoLive: onGoLive,
      onToggleIntel: toggleIntelDrawer,
    });
  }, [rendererRef, searchRef, setSettings, exportPng, onGoLive, onPriceAutoFitKey, onToggleFollowKey, onTogglePriceFollowKey, toggleIntelDrawer]);
}
