import type { Renderer } from '../gl/renderer';
import { AboutDialog } from '../ui/About';
import { IntelligenceDrawer } from '../ui/IntelligenceDrawer';
import { OnboardingCard } from '../ui/OnboardingCard';
import { ReplayPicker } from '../ui/ReplayPicker';
import { SettingsDrawer } from '../ui/SettingsDrawer';
import { ShortcutsOverlay } from '../ui/ShortcutsOverlay';
import { Toaster } from '../ui/Toaster';
import type { FlowMapSettings } from '../ui/settings';
import type { ReplayTarget } from './useWorkspaceActions';

export interface AppOverlaysProps {
  rendererRef: { readonly current: Renderer | null };
  settings: FlowMapSettings;
  /** The live subscription runs a replay: the follow flags then come from the replay camera. */
  replay: boolean;
  applyPatch: (patch: Partial<FlowMapSettings>) => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  onOpenAbout: () => void;
  intelOpen: boolean;
  activeMarket: string;
  activeSymbol: string;
  onCloseIntel: () => void;
  /** The research drawer's source list: close the drawer and open the About dialog. */
  onOpenSources: () => void;
  aboutOpen: boolean;
  onCloseAbout: () => void;
  helpOpen: boolean;
  onCloseHelp: () => void;
  replayPicker: ReplayTarget | null;
  onCloseReplayPicker: () => void;
  onReplayConfirm: (startNs: bigint, endNs: bigint) => void;
}

/**
 * The modal surfaces and the global notices that float above the workspace: the
 * settings drawer, the research drawer, the About dialog, the shortcuts overlay,
 * the replay range picker, the toasts and the first-run tour. Each one mounts
 * only while open, so an idle app pays nothing for them.
 */
export function AppOverlays({
  rendererRef, settings, replay, applyPatch, settingsOpen, onCloseSettings, onOpenAbout,
  intelOpen, activeMarket, activeSymbol, onCloseIntel, onOpenSources, aboutOpen, onCloseAbout,
  helpOpen, onCloseHelp, replayPicker, onCloseReplayPicker, onReplayConfirm,
}: AppOverlaysProps): JSX.Element {
  return (
    <>
      {replayPicker && <ReplayPicker market={replayPicker.market} symbol={replayPicker.symbol}
        onClose={onCloseReplayPicker} onConfirm={onReplayConfirm} />}

      {settingsOpen && (
        <SettingsDrawer
          settings={replay && rendererRef.current
            ? { ...settings, follow: rendererRef.current.following, followPrice: rendererRef.current.priceFollow !== 'off' }
            : settings}
          onChange={applyPatch}
          onClose={onCloseSettings}
          onOpenAbout={onOpenAbout}
        />
      )}

      {intelOpen && (
        <IntelligenceDrawer
          activeSymbol={activeSymbol}
          activeMarket={activeMarket}
          onOpenSources={onOpenSources}
          onClose={onCloseIntel}
        />
      )}

      {aboutOpen && <AboutDialog onClose={onCloseAbout} />}

      {helpOpen && <ShortcutsOverlay onClose={onCloseHelp} />}

      <Toaster />
      <OnboardingCard />
    </>
  );
}
