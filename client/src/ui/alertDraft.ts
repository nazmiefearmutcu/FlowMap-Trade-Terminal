/**
 * The add-alert input's draft: the typed level as a usable price.
 *
 * An empty draft is NOT zero: `Number('')` is 0, which is finite, so it must be
 * rejected explicitly. Zero, negative and non-finite values are not levels either.
 */
export function draftPrice(draft: string): number | null {
  if (draft.trim() === '') return null;
  const v = Number(draft);
  return Number.isFinite(v) && v > 0 ? v : null;
}
