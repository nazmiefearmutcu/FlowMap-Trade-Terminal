/**
 * Honest depth tier for the colormap choice.
 *
 * The renderer keys the synthetic-depth ramp off the capability `depth` tier
 * (see {@link rampForMode} in lut.ts). A replayed recording is the one case
 * where the capability is NOT a live statement about the feed: it describes
 * whatever the recorder captured. Two rules keep that honest:
 *
 *  - The tier the recording carries is used as-is (a keyless-equity recording
 *    keeps `SYNTH`, so it renders amber, not real-depth).
 *  - A replay whose density is not marked `recorded-density` cannot claim real
 *    depth. That is the honest default for a recording whose provenance is
 *    unknown, so its tier is treated as `SYNTH`.
 *  - A replay the recorder flags `synthetic` (the sim market, keyless equity) is
 *    `SYNTH` whatever depth tier it carries.
 *
 * A replay session is recognised by its `playback` block, which only the
 * server's replay feed sends. The `replay: true` badge is NOT that signal: the
 * server sets it on every session to say the build can replay
 * (core/session.py `_capability`), so live sessions carry it too and must pass
 * through unchanged.
 */
export function honestDepthTier(capability: Record<string, unknown> | null | undefined): unknown {
  if (!capability) return undefined;
  if (!isReplayCapability(capability)) return capability.depth;
  if (capability.synthetic === true || capability.depth_provenance !== 'recorded-density') {
    return 'SYNTH';
  }
  return capability.depth;
}

/** True for the synthetic depth tiers: `SYNTH`, and the legacy `SYNTH_PROFILE`. */
function isSyntheticDepthTier(tier: unknown): boolean {
  return tier === 'SYNTH' || tier === 'SYNTH_PROFILE';
}

/** True for a replayed recording: only the server's replay feed sends a `playback` block. */
function isReplayCapability(capability: Record<string, unknown> | null | undefined): boolean {
  return !!capability && typeof capability.playback === 'object' && capability.playback !== null;
}

/** Depth tiers that carry real resting liquidity. */
const REAL_DEPTH_TIERS: ReadonlySet<unknown> = new Set(['L2', 'L2-snapshot', 'L1']);

/** The provenance chip a replay's depth is labelled with. */
export type ReplayDepthChip = 'synthetic' | 'recordedDensity';

/**
 * The provenance chip for a replay's depth, or `null` for a live feed and for a
 * replay whose tier is neither synthetic nor a real tier. It is derived from the
 * same {@link honestDepthTier} the colormap uses, so the top-bar chip, the ladder
 * badge, the crosshair and the legend cannot disagree with the ramp on screen.
 */
export function replayDepthChip(capability: Record<string, unknown> | null | undefined): ReplayDepthChip | null {
  if (!capability || !isReplayCapability(capability)) return null;
  const tier = honestDepthTier(capability);
  if (isSyntheticDepthTier(tier)) return 'synthetic';
  if (REAL_DEPTH_TIERS.has(tier) && capability.depth_provenance === 'recorded-density') return 'recordedDensity';
  return null;
}
