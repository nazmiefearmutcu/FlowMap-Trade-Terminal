/**
 * `C` hotkey for the depth display channel.
 *
 * Invisible mount: just the keyboard surface for cycling
 * sum → bid → ask → imbalance. The channel VALUE lives in the settings store
 * (`depthChannel`) and is applied to the renderer by App; this component never
 * touches the renderer itself.
 */

import { useEffect } from 'react';

import { classifyTarget, routeGlobalKey } from '../input/keys';

interface DepthChannelHotkeyProps {
  /** Called on `C` — App cycles the persisted `depthChannel` setting. */
  onCycle: () => void;
}

export function DepthChannelHotkey({ onCycle }: DepthChannelHotkeyProps): null {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const action = routeGlobalKey(e.key, classifyTarget(e.target));
      if (action?.type !== 'cycle-depth-channel') return;
      e.preventDefault();
      onCycle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCycle]);
  return null;
}
