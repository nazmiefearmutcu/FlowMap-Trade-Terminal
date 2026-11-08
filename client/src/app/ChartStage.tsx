import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react';

import type { Renderer } from '../gl/renderer';
import type { StreamMode } from '../proto/types';
import { useT } from '../i18n/useT';
import { ChartLegend } from '../ui/ChartLegend';
import { ChartStartupGate } from '../ui/ChartStartupGate';
import { ClosedBanner } from '../ui/ClosedBanner';
import { Crosshair } from '../ui/Crosshair';
import { CvdPane } from '../ui/CvdPane';
import { DepthChannelHotkey } from '../ui/DepthChannelHotkey';
import type { DeskPreferences } from '../ui/deskPreferences';
import { DrawingLayer } from '../ui/DrawingLayer';
import { DrawToolbar } from '../ui/DrawToolbar';
import { HeatLegend } from '../ui/HeatLegend';
import { IndicatorOverlayCanvas } from '../ui/IndicatorOverlayCanvas';
import { IndicatorPicker } from '../ui/IndicatorPicker';
import { LiveControls } from '../ui/LiveControls';
import { MeasureTool, rendererChartMap } from '../ui/MeasureTool';
import { PaneResizer } from '../ui/PaneResizer';
import { PerfHud } from '../ui/PerfHud';
import { PriceAlerts } from '../ui/PriceAlerts';
import { PriceAxis } from '../ui/PriceAxis';
import { ReconnectBanner } from '../ui/ReconnectBanner';
import type { FlowMapSettings } from '../ui/settings';
import { TimeAxis } from '../ui/TimeAxis';
import { AppNoticeStack } from './AppNoticeStack';
import { GlFallback } from './GlFallback';
import type { EngineStatus } from './useEngineStatus';
import type { FollowControls } from './useFollowControls';
import type { GraphicsDiagnostics } from './useGraphicsDiagnostics';
import { CHART_HELP_ID } from './workspaceScope';

export interface ChartStageProps {
  rendererRef: { readonly current: Renderer | null };
  canvasRef: RefObject<HTMLCanvasElement>;
  priceAxisRef: RefObject<HTMLCanvasElement>;
  timeAxisRef: RefObject<HTMLCanvasElement>;
  /** The container every data-space overlay anchors to. */
  viewportRef: RefObject<HTMLDivElement>;
  settings: FlowMapSettings;
  desk: DeskPreferences;
  setDesk: Dispatch<SetStateAction<DeskPreferences>>;
  activeMarket: string;
  activeSymbol: string;
  /** The stream mode the live controls show. */
  mode: StreamMode;
  /** The chart shows the simulated feed. */
  simActive: boolean;
  recordingDegraded: boolean;
  engine: EngineStatus;
  /** Set while the WebGL2 fallback replaces the chart. */
  glError: string | null;
  /** The renderer failure, from the lifecycle error or the frame sampler. */
  glFailure: string | null;
  graphics: GraphicsDiagnostics;
  onRetryRenderer: () => void;
  /** Offline DEV harnesses have no market session, so the startup gate stays off. */
  offlineHarness: boolean;
  onGoLive: FollowControls['onGoLive'];
  onTrackPrice: FollowControls['onTrackPrice'];
  onSetPriceFollow: FollowControls['onSetPriceFollow'];
  onToggleHud: () => void;
  onCycleDepthChannel: () => void;
  /** Subscribe again to an instrument (the startup gate's retry). */
  onSelectSymbol: (market: string, symbol: string) => void;
  /** Open the symbol search (the startup gate's way to another instrument). */
  onSearchSymbols: () => void;
}

/**
 * The heatmap stage: the GL canvas and its keyboard reference, the fallback and
 * notice stack, the price and time gutters, the CVD pane and the startup gate.
 *
 * The overlay stack, bottom to top: GL canvas, indicator overlay, drawings,
 * measure, alert markers, crosshair and HUD. Each layer manages its own
 * pointer-events, so none steals chart pan or zoom while it is disarmed.
 */
export function ChartStage({
  rendererRef, canvasRef, priceAxisRef, timeAxisRef, viewportRef, settings, desk, setDesk,
  activeMarket, activeSymbol, mode, simActive, recordingDegraded, engine, glError, glFailure,
  graphics, onRetryRenderer, offlineHarness, onGoLive, onTrackPrice, onSetPriceFollow,
  onToggleHud, onCycleDepthChannel, onSelectSymbol, onSearchSymbols,
}: ChartStageProps): JSX.Element {
  const t = useT();
  // ONE mapping pair for every data-space overlay (measure / drawings / indicators).
  // `rendererChartMap` closes over the renderer REF, so each `fromChart`/`toChart`
  // call reads the LIVE camera/cache at call time.
  const chartMap = useMemo(() => rendererChartMap(rendererRef), [rendererRef]);
  // One stable reader of the renderer's time map for every overlay that needs
  // the candle/heatmap time base (IndicatorOverlayCanvas, DrawingLayer).
  const getTimeBase = useCallback(() => rendererRef.current?.timeline()?.timeBase ?? null, [rendererRef]);

  return (
    <div className={`stage${settings.overlays.cvd ? ' stage--cvd' : ''}`}>
      <div className={`stage__viewport${settings.overlays.volume ? ' stage__viewport--volume' : ''}`} ref={viewportRef}>
        <canvas
          id="gl"
          ref={canvasRef}
          className="gl-canvas"
          role="application"
          tabIndex={0}
          aria-label={t('chart.ariaLabel', { instrument: `${activeMarket}:${activeSymbol}` })}
          aria-describedby={CHART_HELP_ID}
        />
        <span id={CHART_HELP_ID} className="app-visually-hidden">{t('chart.ariaHelp')}</span>
        {glFailure !== null && (
          <GlFallback failure={glFailure} onRetry={onRetryRenderer} copyState={graphics.copyState}
            onCopyDiagnostics={graphics.copyDiagnostics} />
        )}
        <AppNoticeStack engine={engine} recordingDegraded={recordingDegraded} simActive={simActive} />
        <IndicatorOverlayCanvas chartMap={chartMap} getTimeBase={getTimeBase} />
        <DrawingLayer
          containerRef={viewportRef}
          chartMap={chartMap}
          symbol={activeSymbol}
          market={activeMarket}
          getTimeBase={getTimeBase}
        />
        <MeasureTool containerRef={viewportRef} map={chartMap} />
        <PriceAlerts rendererRef={rendererRef} containerRef={viewportRef} soundEnabled={settings.alertSound} />
        <Crosshair canvasRef={canvasRef} rendererRef={rendererRef} />
        {glError === null && <ChartLegend overlays={settings.overlays} />}
        <HeatLegend colormap={settings.colormap} channel={settings.depthChannel} />
        <PerfHud rendererRef={rendererRef} visible={settings.hudVisible} onToggle={onToggleHud} />
        <ClosedBanner />
        <ReconnectBanner />
        <LiveControls rendererRef={rendererRef} onGoLive={onGoLive} onTrackPrice={onTrackPrice} mode={mode} />
        <DrawToolbar symbol={activeSymbol} />
        <IndicatorPicker />
        <DepthChannelHotkey onCycle={onCycleDepthChannel} />
      </div>
      <PriceAxis canvasRef={priceAxisRef} rendererRef={rendererRef} onSetPriceFollow={onSetPriceFollow} />
      {settings.overlays.cvd && (
        <>
          <CvdPane rendererRef={rendererRef} />
          <div className="cvd-corner" aria-hidden="true" />
          <PaneResizer axis="y" variable="--desk-cvd-height" value={desk.cvdHeight} min={60} max={220}
            label={t('desk.resizeCvd')} onCommit={cvdHeight => setDesk(prev => ({ ...prev, cvdHeight }))} />
        </>
      )}
      <TimeAxis canvasRef={timeAxisRef} />
      <div className="stage__corner" aria-hidden="true" />
      <ChartStartupGate rendererRef={rendererRef} disabled={glFailure !== null || offlineHarness}
        onRetry={onRetryRenderer} onResubscribe={onSelectSymbol} onSearchSymbols={onSearchSymbols} />
    </div>
  );
}
