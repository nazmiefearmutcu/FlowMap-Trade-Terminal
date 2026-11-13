/** Liquidity scale from the same resolved descriptor used by PNG export. */
import type { Colormap } from '../gl/lut';
import type { DepthChannelMode } from './settings';
import { useEffect, useState } from 'react';
import { useFlowMapStore } from '../state/store';
import { useT } from '../i18n/useT';
import { getSnapshot, subscribe as subscribeBook } from '../state/bookStore';
import { useTheme } from '../theme';
import { depthIsSynthetic, depthReadoutTier, resolveLegend } from './heatLegendModel';
import { depthScopeKey } from './symbols';
import type { ChartStop } from '../theme/registry';
interface HeatLegendProps { colormap: Colormap; channel: DepthChannelMode }
export type LegendStop = ChartStop;
/** Compatibility wrapper; all routing belongs to the shared legend model. */
export function legendForChannel(channel: DepthChannelMode, colormap: Colormap, synth: boolean, themeStops?: readonly LegendStop[] | null, themeSynthStops?: readonly LegendStop[] | null) {
 return resolveLegend({channel,colormap,synth},themeStops,themeSynthStops);
}

export function HeatLegend({ colormap, channel }: HeatLegendProps): JSX.Element {
  const { theme } = useTheme();
  // Subscribes to locale changes: resolveLegend reads the locale at call time.
  const t = useT();
  const capability = useFlowMapStore((s) => s.capability);
  // The readout falls back to the live book mode, so a SYNTH_PROFILE book never
  // reads as real liquidity here.
  const [bookMode, setBookMode] = useState<number | null>(() => getSnapshot().book?.mode ?? null);
  useEffect(() => subscribeBook((snap) => setBookMode(snap.book ? snap.book.mode : null)), []);
  // Same verdict as the renderer's ramp: a replayed recording is synthetic unless
  // it is marked recorded-density, so the legend never draws real-depth ink for it.
  const synth = depthIsSynthetic(capability, bookMode);
  const tier = depthReadoutTier(capability, bookMode);
  const recorded = capability?.depth_provenance === 'recorded-density';
  // A book that covers only some exchanges says so: the tier's title names the
  // scope, and the short scope name joins the tier for screen readers.
  const scopeKey = depthScopeKey(capability);
  const scopeTitle = scopeKey ? t(scopeKey) : undefined;
  const tierLabel = tier && scopeKey ? `${tier} · ${t('depthScope.cboeTop5.short')}` : tier;
  const legend = resolveLegend({ channel, colormap, synth, theme });
  const channelSuffix =
    channel === 'sum' || synth ? '' : t('heat.channelSuffix', { channel });
  return (
    <div
      className={`heat-legend${synth ? ' heat-legend--synth' : ''}${
        !synth && channel === 'imbalance' ? ' heat-legend--divergent' : ''
      }`}
      data-testid="heat-legend"
      data-channel={legend.effectiveChannel}
      role="img"
      aria-label={t('heat.ariaLabel', { ramp: legend.rampName, channel: channelSuffix, tier: tierLabel ? t('heat.tierSuffix', { tier: tierLabel }) : '' })}
    >
      <span className="heat-legend__cap">{legend.topCap}</span>
      <div
        className="heat-legend__bar"
        data-testid="heat-legend-bar"
        data-ramp={legend.row}
        style={{
          background: `linear-gradient(to top, ${legend.gradient})`,
          // Bookmap-style swatch frame: the ramp's low end is near-black on the
          // midnight chip (invisible edge), so every legend — not just the
          // divergent one (CSS keeps its own rule) — gets a defined outline.
          // `width` compensates the 2×1px border (border-box) so the painted
          // gradient keeps its original 8px stem.
          border: '1px solid var(--chart-chip-border, var(--line))',
          width: 10,
        }}
        aria-hidden="true"
      />
      <span className="heat-legend__cap">{legend.bottomCap}</span>
      <span
        className={`heat-legend__tier${tier === 'L2-SNAPSHOT' ? ' heat-legend__tier--caution' : ''}`}
        data-testid="heat-legend-tier"
        title={scopeTitle ?? (recorded ? t('depthChip.recorded') : undefined)}
      >
        {tier ?? 'liq'}
      </span>
      {legend.channelNote !== null && (
        <span className="heat-legend__channel" data-testid="heat-legend-channel">
          {legend.channelNote}
        </span>
      )}
    </div>
  );
}
