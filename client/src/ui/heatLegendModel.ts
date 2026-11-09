/** One resolved descriptor for the on-screen scale and exported PNG. */
import { rampCssGradient, rampCssGradientReversed, rampForColormap, RAMP_IMBALANCE, RAMP_SYNTH, RAMP_THEME, RAMP_THEME_SYNTH, type Colormap } from '../gl/lut';
import { resolveAppearance, stopsGradient } from '../theme/appearance';
import type { ThemeId, ChartStop } from '../theme/registry';
import type { DepthChannelMode } from './settings';
import { honestDepthTier } from '../gl/depthTier';
import { depthTier } from './DomLadderTier';
import { MODE_SYNTH_PROFILE } from '../proto/types';
import { t } from '../i18n';
export interface LegendInput {
   channel?: DepthChannelMode;
   colormap: Colormap;
   synth?: boolean;
   theme?: ThemeId;
   tier?: string;
}
export interface LegendDescriptor {
   row: number;
   gradient: string;
   topCap: string;
   bottomCap: string;
   channelNote: string | null;
   rampName: string;
   effectiveChannel: DepthChannelMode;
}
export function resolveLegend(input: LegendInput, density?: readonly ChartStop[] | null, synthStops?: readonly ChartStop[] | null): LegendDescriptor {
  const { colormap, synth } = input;
  const channel = synth ? 'sum' : input.channel ?? 'sum';
  const appearance = input.theme ? resolveAppearance(input.theme, colormap) : null;
  const activeDensity = appearance?.density ?? density;
  const activeSynth = appearance?.synth ?? synthStops;
  let row: number;
  let gradient: string;
  let rampName: string;
  if (synth) {
   row = activeSynth ? RAMP_THEME_SYNTH : RAMP_SYNTH;
   gradient = activeSynth ? stopsGradient(activeSynth) : rampCssGradient(row);
   rampName = t('heat.rampSynthetic');
  } else if (channel === 'imbalance') {
   row = RAMP_IMBALANCE;
   gradient = appearance ? stopsGradient(appearance.imbalance, true) : rampCssGradientReversed(row);
   rampName = t('heat.rampImbalance');
  } else {
   row = activeDensity ? RAMP_THEME : rampForColormap(colormap);
   gradient = activeDensity ? stopsGradient(activeDensity) : rampCssGradient(row);
   rampName = t('heat.rampColormap', { name: colormap });
  }
  return { row, gradient, rampName, effectiveChannel: channel,
   topCap: channel === 'imbalance' ? t('heat.capAskHeavy') : t('heat.capMore'),
   bottomCap: channel === 'imbalance' ? t('heat.capBidHeavy') : t('heat.capLess'),
   channelNote: channel === 'bid' ? t('heat.channelBid') : channel === 'ask' ? t('heat.channelAsk') : null };
}

/**
 * Whether the depth on screen is synthetic. A capability the server marks
 * `synthetic: true` (the sim feed and keyless equity recordings) is synthetic
 * whatever its tier says. Otherwise the verdict follows the renderer's ramp
 * ({@link honestDepthTier}): a replay without recorded-density provenance is
 * SYNTH, a recorded replay keeps the tier its recording carries, and the book
 * mode decides only when the capability names no tier. The legend, crosshair
 * and measure readouts all read this, so they agree with the amber ramp.
 */
export function depthIsSynthetic(capability: Record<string, unknown> | null | undefined, bookMode: number | null): boolean {
  if (capability?.synthetic === true) return true;
  const honest = honestDepthTier(capability);
  if (typeof honest === 'string') return honest === 'SYNTH' || honest === 'SYNTH_PROFILE';
  return bookMode === MODE_SYNTH_PROFILE;
}

/**
 * The depth label every readout prints (legend tier, crosshair source tag, measure
 * depth): `SYNTH` for synthetic depth, `L2-SNAPSHOT` for a polled venue book, which
 * is a snapshot and must never read as a native L2 feed, and otherwise the
 * {@link depthTier} of the DOM ladder. Shared here so the three surfaces agree.
 */
export function depthReadoutTier(capability: Record<string, unknown> | null | undefined, bookMode: number | null): string | null {
  if (depthIsSynthetic(capability, bookMode)) return 'SYNTH';
  const declared = honestDepthTier(capability);
  if (declared === 'L2-snapshot') return 'L2-SNAPSHOT';
  // A tier string this client does not know is not a book mode to fall back on:
  // naming it from the grid's book mode could print a native L2 for it. Say nothing.
  if (typeof declared === 'string' && !KNOWN_DEPTH_TIERS.has(declared)) return null;
  return depthTier(capability ?? null, bookMode);
}

/** The depth tiers the readouts know how to name (see {@link depthTier}). */
const KNOWN_DEPTH_TIERS: ReadonlySet<string> = new Set(['L2', 'L2-snapshot', 'L1_BAND', 'L1', 'SYNTH', 'SYNTH_PROFILE']);
