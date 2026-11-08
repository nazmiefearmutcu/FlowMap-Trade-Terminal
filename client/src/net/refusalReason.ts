/**
 * Maps a server refusal reason (`Status.capability.reason`, a protocol token such
 * as `invalid_symbol`) to an i18n key for the sentence that explains it. The raw
 * token is never user copy: an unknown token gets the generic key, not the token.
 */

const REFUSAL_REASON_KEYS: ReadonlyMap<string, string> = new Map([
  ['invalid_symbol', 'banner.refusalReason.invalidSymbol'],
]);

/** Key for a generic reason, used when the server sends a token this build does not know. */
export const REFUSAL_REASON_UNKNOWN_KEY = 'banner.refusalReason.unknown';

/**
 * The i18n key explaining a refusal reason, or `null` when the server gave none
 * (absent or empty). Known tokens map to their own key; any other non-empty
 * token maps to {@link REFUSAL_REASON_UNKNOWN_KEY}.
 */
export function refusalReasonKey(reason: string | null): string | null {
  if (reason === null || reason === '') return null;
  return REFUSAL_REASON_KEYS.get(reason) ?? REFUSAL_REASON_UNKNOWN_KEY;
}
