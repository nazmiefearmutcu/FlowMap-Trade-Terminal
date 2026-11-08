import { useCallback, useState } from 'react';

import type { Renderer } from '../gl/renderer';
import { useT } from '../i18n/useT';
import { useFlowMapStore } from '../state/store';
import { getTheme } from '../theme';
import { collectExportLayers, exportProvenanceNotes, runPngExport } from '../ui/exportPng';
import type { FlowMapSettings } from '../ui/settings';
import { SIM_MARKET, SIM_SYMBOL } from './workspaceScope';

export interface ChartExport {
  /** Non-null while the "export refused" note shows in the TopBar. */
  exportNotice: string | null;
  exportPng: () => void;
  dismissExportNotice: () => void;
}

/**
 * PNG export. The top-bar button and the bare `E` key both route through
 * `exportPng`: the download composes ALL chart layers (GL heat, 2D ink, both
 * gutters, legend chips and the provenance footer). `collectExportLayers` forces
 * a fresh frame and gates the honest null (lost GL context); on null the TopBar
 * shows a dismissible note, never a fake success. State is read at call time so
 * the filename and the caveats describe what is on screen right now.
 */
export function useChartExport(
  rendererRef: { readonly current: Renderer | null },
  settingsRef: { readonly current: FlowMapSettings },
): ChartExport {
  const t = useT();
  // Cleared by dismissal or by a later successful export.
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const exportPng = useCallback(() => {
    const { subscription: sub, capability } = useFlowMapStore.getState();
    const renderer = rendererRef.current;
    const filename = runPngExport(
      collectExportLayers(renderer, document),
      sub?.market ?? SIM_MARKET,
      sub?.symbol ?? SIM_SYMBOL,
      new Date(),
      undefined,
      {
        mode: sub?.mode ?? 'live',
        // The exported legend and overlay set match what is on screen.
        overlays: settingsRef.current.overlays,
        notes: exportProvenanceNotes({ following: renderer?.following ?? null, mode: sub?.mode, capability }),
        legend: {
          colormap: settingsRef.current.colormap,
          theme: getTheme(),
          channel: settingsRef.current.depthChannel,
          synth: typeof capability?.depth === 'string' && capability.depth.startsWith('SYNTH'),
          tier: typeof capability?.depth === 'string' ? capability.depth : undefined,
        },
      },
    );
    setExportNotice(filename ? null : t('export.unavailable'));
  }, [rendererRef, settingsRef, t]);

  const dismissExportNotice = useCallback(() => setExportNotice(null), []);

  return { exportNotice, exportPng, dismissExportNotice };
}
