import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { safeLocalStorage } from '../state/safeStorage';
import { loadDeskPreferences, saveDeskPreferences, type DeskLayout, type DeskPreferences } from '../ui/deskPreferences';
import type { FlowMapSettings } from '../ui/settings';

/** The splitter sizes and overlay choices a layout applies. */
export interface LayoutPreset {
  domRatio: number;
  cvdHeight: number;
  railVisible: boolean;
  cvd: boolean;
  profile: boolean;
}

/** The preset a layout applies when it has no remembered arrangement. */
export function layoutPreset(layout: DeskLayout): LayoutPreset {
  const analysis = layout === 'analysis';
  return {
    domRatio: analysis ? 0.4 : 0.55,
    cvdHeight: analysis ? 160 : 104,
    railVisible: layout !== 'focus',
    cvd: layout !== 'focus',
    profile: analysis,
  };
}

/** A layout's manual arrangement, remembered while the app runs. */
type DeskMemory = Pick<LayoutPreset, 'domRatio' | 'cvdHeight' | 'railVisible' | 'cvd' | 'profile'>;

export interface DeskLayoutState {
  desk: DeskPreferences;
  setDesk: Dispatch<SetStateAction<DeskPreferences>>;
  /** Press a layout: restores its remembered arrangement, or applies its preset. */
  selectDesk: (layout: DeskLayout) => void;
  toggleRail: () => void;
  /** CSS custom properties carrying the splitter sizes onto the desk root. */
  deskStyle: CSSProperties;
}

/**
 * Desk layout: the persisted layout and splitter sizes, the per-layout memory,
 * and the rail toggle. The sizes persist on every change (deskPreferences).
 */
export function useDeskLayout(
  settings: FlowMapSettings,
  setSettings: Dispatch<SetStateAction<FlowMapSettings>>,
): DeskLayoutState {
  const [desk, setDesk] = useState(() => loadDeskPreferences(safeLocalStorage()));
  useEffect(() => saveDeskPreferences(safeLocalStorage(), desk), [desk]);
  const deskMemoryRef = useRef<Partial<Record<DeskLayout, DeskMemory>>>({});

  // A layout press remembers the splitter sizes and the CVD/profile choices of
  // the layout it leaves, and restores them when that layout is picked again, so
  // a manual arrangement survives switching presets. Pressing the layout that is
  // already active applies its preset: the explicit way back to defaults.
  const selectDesk = (layout: DeskLayout): void => {
    const memory = deskMemoryRef.current;
    if (layout !== desk.layout) {
      memory[desk.layout] = {
        domRatio: desk.domRatio, cvdHeight: desk.cvdHeight, railVisible: settings.railVisible,
        cvd: settings.overlays.cvd, profile: settings.overlays.profile,
      };
    }
    const remembered = layout !== desk.layout ? memory[layout] : undefined;
    if (remembered) {
      setDesk(prev => ({ ...prev, layout, domRatio: remembered.domRatio, cvdHeight: remembered.cvdHeight }));
      setSettings(prev => ({ ...prev, railVisible: remembered.railVisible, overlays: {
        ...prev.overlays, cvd: remembered.cvd, profile: remembered.profile,
      } }));
      return;
    }
    const preset = layoutPreset(layout);
    setDesk(prev => ({ ...prev, layout, domRatio: preset.domRatio, cvdHeight: preset.cvdHeight }));
    setSettings(prev => ({ ...prev, railVisible: preset.railVisible, overlays: {
      ...prev.overlays, cvd: preset.cvd, profile: preset.profile,
    } }));
  };

  const toggleRail = useCallback(() => {
    setSettings((prev) => ({ ...prev, railVisible: !prev.railVisible }));
    setDesk(prev => prev.layout === 'focus' ? { ...prev, layout: 'orderflow' } : prev);
  }, [setSettings]);

  const deskStyle = { '--desk-rail-width': `${desk.railWidth}px`, '--desk-dom-ratio': desk.domRatio,
    '--desk-cvd-height': `${desk.cvdHeight}px` } as CSSProperties;

  return { desk, setDesk, selectDesk, toggleRail, deskStyle };
}
