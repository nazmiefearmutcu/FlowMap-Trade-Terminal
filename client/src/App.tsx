import { useCallback, useRef, useState } from 'react';

// Stylesheet order. The cascade follows module evaluation order, and several
// shell stylesheets share selectors at equal specificity, so the order the
// shell has always had is pinned here. The hooks and components below no longer
// import these files in that sequence, so the order would otherwise drift.
import './ui/ChartLegend.css';
import './ui/TradingPanels.css';
import './ui/Crosshair.css';
import './theme/shell.css';
import './drawings/drawings.css';
import './indicators/indicators.css';
import './ui/IntelligenceDrawer.css';
import './ui/features.css';
import './ui/MarketStrip.css';
import './ui/Desk.css';
import './ui/AppNotices.css';
import './app/AppShell.css';
import './ui/About.css';
import './ui/ChartStartupGate.css';
import './ui/Tape.css';
import './ui/ReplayPicker.css';
import './ui/TopBar.css';
import './watchlist/watchlist.css';

import type { Renderer } from './gl/renderer';
import { useT } from './i18n/useT';
import { useTheme } from './theme';
import { useIntelligenceStore } from './state/intelligenceStore';
import { MarketStrip } from './ui/MarketStrip';
import { DeskToolbar } from './ui/DeskToolbar';
import { Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';
import type { SymbolSearchHandle } from './ui/SymbolSearch';
import { DEPTH_CHANNELS, loadSettings, type FlowMapSettings } from './ui/settings';
import { useAlertMonitor } from './state/alertMonitor';
import { safeLocalStorage } from './state/safeStorage';
import { sessionResetKey, useFlowMapStore } from './state/store';
import { AppOverlays } from './app/AppOverlays';
import { ChartStage } from './app/ChartStage';
import { RightRail } from './app/RightRail';
import { useChartExport } from './app/useChartExport';
import { useGraphicsDiagnostics } from './app/useGraphicsDiagnostics';
import { useWorkspaceActions } from './app/useWorkspaceActions';
import { SIM_MARKET, SIM_SYMBOL } from './app/workspaceScope';
import { useChartThemeBridge, useChartThemeSync } from './app/useChartThemeBridge';
import { useDeskLayout } from './app/useDeskLayout';
import { useEngineStatus } from './app/useEngineStatus';
import { useHelpToggle } from './app/useShellKeys';
import { useHistoryPrefetch } from './app/useHistoryPrefetch';
import { useRenderFailure } from './app/useRenderFailure';
import { useRendererLifecycle } from './app/useRendererLifecycle';
import { useSettingsApply } from './app/useSettingsApply';
import { useStreamClock } from './app/streamClock';
import { useFollowReconcile, useSessionResetBridge, type LiveFollow } from './app/useSessionFollow';
import { useFollowControls } from './app/useFollowControls';
import { useGlobalChartKeys } from './app/useGlobalChartKeys';

/**
 * The workspace shell: the top bar (symbol search / venue / capability badges /
 * live-replay toggle / clock), the heatmap stage (dominant GL canvas + price/time
 * axis gutters + overlays) with the collapsible right rail (DOM ladder + tape),
 * the bottom timeline (session minimap + replay transport), and the settings
 * drawer.
 *
 * This component composes the hooks in app/: each owns one concern (renderer
 * lifecycle, engine status, desk layout, theme bridge, settings apply, follow
 * policy, workspace actions, PNG export, shortcuts). It also places the stage,
 * the rail and the overlays. The hooks are called in the order their effects
 * always ran, which keeps the boot sequence the same.
 *
 * High-frequency data stays out of React: the Renderer owns the canvas and reads
 * the store's raw stream directly; this component only holds low-frequency UI
 * state and polls the renderer's timeline geometry at ≤5 Hz.
 */

export function App() {
  // Offline DEV harnesses deliberately have no market session or presented
  // frame; their injected data and pointer interactions must remain reachable.
  const offlineHarness = import.meta.env.DEV && (() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('test') === 'heatmap' ||
      ['panels', 'perf', 'normalize', 'overlays'].some(mode => params.get(mode) === '1');
  })();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const priceAxisRef = useRef<HTMLCanvasElement>(null);
  const timeAxisRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const searchRef = useRef<SymbolSearchHandle>(null);
  // The chart container every data-space overlay (measure / drawings / indicator
  // canvas) anchors to.
  const stageViewportRef = useRef<HTMLDivElement>(null);
  // The symbol a Retry should reconnect to (set only by Retry, read once).
  const retryTargetRef = useRef<{ market: string; symbol: string } | null>(null);

  const [settings, setSettings] = useState<FlowMapSettings>(() =>
    loadSettings(safeLocalStorage()),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { desk, setDesk, selectDesk, toggleRail, deskStyle } = useDeskLayout(settings, setSettings);
  const intelDrawerOpen = useIntelligenceStore((s) => s.drawerOpen);
  const setIntelDrawerOpen = useIntelligenceStore((s) => s.setDrawerOpen);
  const toggleIntelDrawer = useIntelligenceStore((s) => s.toggleDrawer);
  // WebGL2 unavailable: the heatmap canvas cannot render, but the DOM panels
  // (ladder, tape, search) can — the app degrades instead of dying.
  const [glError, setGlError] = useState<string | null>(null);
  // Bumped by the fallback's Retry to re-create the renderer on the canvas.
  const [rendererAttempt, setRendererAttempt] = useState(0);
  // The About and legal dialog: from settings, or from the research drawer.
  const [aboutOpen, setAboutOpen] = useState(false);
  // True while the server's recording writer is stalled (Status.capability.recording_health).
  const recordingDegraded = useFlowMapStore((s) => s.recordingDegraded);
  // True while the server's market overview runs past its own deadline (Status.capability.overview_degraded).
  const overviewDegraded = useFlowMapStore((s) => s.capability?.overview_degraded === true);

  const t = useT();
  // Theme: App re-renders only on an actual theme switch (useSyncExternalStore),
  // which is human-frequency.
  const { theme } = useTheme();
  const { syncChartTheme, resetChartThemeSignature } = useChartThemeSync(rendererRef);

  // Evaluates armed alerts for NON-active symbols by polling `/api/quote` through
  // the shared quoteFeed (visibility-gated, stale-skipping).
  useAlertMonitor();

  // Keep the latest settings reachable from the mount-only renderer effect.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const prevSettingsRef = useRef(settings);
  // Keep exact LIVE policies independently of the replay camera. The persisted
  // price switch is boolean and cannot distinguish fit from track.
  const liveFollowRef = useRef<LiveFollow>({
    time: settings.follow, price: settings.followPrice ? 'fit' : 'off',
  });

  useSessionResetBridge(rendererRef, liveFollowRef, setSettings);
  useRendererLifecycle({
    canvasRef, priceAxisRef, timeAxisRef, rendererRef, retryTargetRef, settingsRef,
    syncChartTheme, resetChartThemeSignature, rendererAttempt, setGlError,
  });
  const [renderFailure, setRenderFailure] = useRenderFailure(rendererRef, rendererAttempt);
  const engine = useEngineStatus();
  useSettingsApply(settings, rendererRef, prevSettingsRef, liveFollowRef, syncChartTheme);
  useFollowReconcile(rendererRef, liveFollowRef, setSettings);
  const {
    onGoLive, onTrackPrice, onSetPriceFollow, onToggleFollowKey, onTogglePriceFollowKey, onPriceAutoFitKey,
  } = useFollowControls(rendererRef, setSettings);

  // Session generation teardown happens synchronously in the renderer lifecycle.
  const subscription = useFlowMapStore((s) => s.subscription);
  useHistoryPrefetch(sessionResetKey(subscription), rendererRef, settingsRef);
  const streamClock = useStreamClock(rendererRef);
  const [helpOpen, setHelpOpen] = useHelpToggle();
  useChartThemeBridge(theme, settings.colormap, syncChartTheme);

  const glFailure = glError ?? renderFailure;
  const graphics = useGraphicsDiagnostics(glFailure);

  // Retry rebuilds the renderer on the same canvas and reconnects to the symbol
  // on screen (live). The renderer effect reads the target once on mount.
  const openSymbolSearch = useCallback(() => searchRef.current?.open(), []);
  const retryRenderer = useCallback(() => {
    const sub = useFlowMapStore.getState().subscription;
    retryTargetRef.current = sub ? { market: sub.market, symbol: sub.symbol } : null;
    setGlError(null);
    setRenderFailure(null);
    setRendererAttempt((n) => n + 1);
  }, [setRenderFailure]);

  const {
    replayPicker, closeReplayPicker, applyPatch, onSelectSymbol, onSetMode, onReplayConfirm,
  } = useWorkspaceActions(rendererRef, settingsRef, setSettings);
  const { exportNotice, exportPng, dismissExportNotice } = useChartExport(rendererRef, settingsRef);

  // Bare-key workspace shortcuts (Space, `/`, `E`, F, P, Shift+P, R, J).
  useGlobalChartKeys({
    rendererRef, searchRef, setSettings, exportPng, toggleIntelDrawer, follow: {
      onGoLive, onToggleFollowKey, onTogglePriceFollowKey, onPriceAutoFitKey,
    },
  });

  const toggleHud = useCallback(
    () => setSettings((p) => ({ ...p, hudVisible: !p.hudVisible })),
    [],
  );
  const cycleDepthChannel = useCallback(() => {
    setSettings((p) => ({
      ...p,
      depthChannel: DEPTH_CHANNELS[(DEPTH_CHANNELS.indexOf(p.depthChannel) + 1) % DEPTH_CHANNELS.length],
    }));
  }, []);

  // Active chart scope for the per-symbol overlays (drawings persistence +
  // toolbar label). The store's subscription is the source of truth.
  const activeSymbol = subscription?.symbol ?? SIM_SYMBOL;
  const activeMarket = subscription?.market ?? SIM_MARKET;

  return (
    <div className="app" data-desk-root data-desk-layout={desk.layout} style={deskStyle}>
      <TopBar
        ref={searchRef}
        onSelectSymbol={onSelectSymbol}
        onSetMode={onSetMode}
        railVisible={settings.railVisible}
        onToggleRail={toggleRail}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleIntel={toggleIntelDrawer}
        onExportPng={exportPng}
        exportNotice={exportNotice}
        onDismissExportNotice={dismissExportNotice}
        streamClock={streamClock}
      />
      <MarketStrip rendererRef={rendererRef} />
      <DeskToolbar rendererRef={rendererRef} settings={settings} layout={desk.layout} onLayout={selectDesk}
        onChange={applyPatch} onTrack={onTrackPrice} onFit={() => {
          rendererRef.current?.setTimeWindowMs(null);
          rendererRef.current?.setPriceFollow('fit');
          if (useFlowMapStore.getState().subscription?.mode !== 'replay') setSettings(prev => ({ ...prev, followPrice: true }));
        }} />

      <main className="workspace">
        <h1 className="app-visually-hidden">{t('app.heading')}</h1>
        <ChartStage
          rendererRef={rendererRef}
          canvasRef={canvasRef}
          priceAxisRef={priceAxisRef}
          timeAxisRef={timeAxisRef}
          viewportRef={stageViewportRef}
          settings={settings}
          desk={desk}
          setDesk={setDesk}
          activeMarket={activeMarket}
          activeSymbol={activeSymbol}
          mode={subscription?.mode ?? 'live'}
          simActive={subscription?.market === SIM_MARKET}
          recordingDegraded={recordingDegraded}
          overviewDegraded={overviewDegraded}
          engine={engine}
          glError={glError}
          glFailure={glFailure}
          graphics={graphics}
          onRetryRenderer={retryRenderer}
          offlineHarness={offlineHarness}
          onGoLive={onGoLive}
          onTrackPrice={onTrackPrice}
          onSetPriceFollow={onSetPriceFollow}
          onToggleHud={toggleHud}
          onCycleDepthChannel={cycleDepthChannel}
          onSelectSymbol={onSelectSymbol}
          onSearchSymbols={openSymbolSearch}
        />
        {settings.railVisible && (
          <RightRail desk={desk} setDesk={setDesk} bigTradeUsd={settings.bigTradeUsd}
            activeKey={`${activeMarket}:${activeSymbol}`} onSelectSymbol={onSelectSymbol} />
        )}
      </main>

      <Timeline rendererRef={rendererRef} onGoLive={onGoLive} />

      <AppOverlays
        rendererRef={rendererRef}
        settings={settings}
        replay={subscription?.mode === 'replay'}
        applyPatch={applyPatch}
        settingsOpen={settingsOpen}
        onCloseSettings={() => setSettingsOpen(false)}
        onOpenAbout={() => setAboutOpen(true)}
        intelOpen={intelDrawerOpen}
        activeMarket={activeMarket}
        activeSymbol={activeSymbol}
        onCloseIntel={() => setIntelDrawerOpen(false)}
        onOpenSources={() => {
          setIntelDrawerOpen(false);
          setAboutOpen(true);
        }}
        aboutOpen={aboutOpen}
        onCloseAbout={() => setAboutOpen(false)}
        helpOpen={helpOpen}
        onCloseHelp={() => setHelpOpen(false)}
        replayPicker={replayPicker}
        onCloseReplayPicker={closeReplayPicker}
        onReplayConfirm={onReplayConfirm}
      />
    </div>
  );
}
