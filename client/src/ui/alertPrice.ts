/**
 * Price text for price-alert levels: the one format the alert chip,
 * the marker tags, the popover rows and the delete labels share.
 *
 * A level prints the digits it was typed with: the shortest round-trip form,
 * capped at twelve places, with at least two places. So 75759.5 reads 75759.50,
 * a typed 0.00001234 keeps its digits, and binary noise never leaks (no
 * 1234567.891000000061). It is never digit-grouped (see i18n/format
 * `formatPrice`), so a level reads the same on every surface and in every locale.
 */
/** The fixed-place floor for a level, and the most places `toFixed` will print. */
const LEVEL_PLACES = 12;
const MAX_FIXED_PLACES = 100;

/**
 * Decimal places the shortest form of an exponent-notation value needs to show
 * every significant digit in fixed notation (`1.5e-13` → 14), or -1 for a large
 * value that has no fixed form worth printing (`1e+21`).
 */
function exponentPlaces(text: string): number {
  const [mantissa, exp] = text.split('e');
  const e = Number(exp);
  if (e >= 0) return -1;
  const significant = mantissa.replace(/[-.]/g, '').length;
  return significant - 1 - e;
}

export function alertPriceText(price: number): string {
  if (!Number.isFinite(price)) return '—';
  let text = String(price);
  const dot = text.indexOf('.');
  const shortDecimals = dot < 0 ? 0 : text.length - dot - 1;
  if (text.includes('e')) {
    // Exponent form (magnitudes below 1e-6). The twelve-place floor still applies,
    // but a value smaller than 1e-12 needs more places: fixed twelve would print
    // 1e-13 as 0.00 and hide the level, so print its own digits instead.
    const places = exponentPlaces(text);
    if (places < 0 || places > MAX_FIXED_PLACES) return text;
    text = price.toFixed(Math.max(LEVEL_PLACES, places));
  } else if (shortDecimals > LEVEL_PLACES) {
    // Over-long binary expansions are rounded to the twelve-place cap.
    text = price.toFixed(LEVEL_PLACES);
  }
  const point = text.indexOf('.');
  if (point < 0) return `${text}.00`;
  let end = text.length;
  // Drop trailing zeros, but never below two decimal places.
  while (end > point + 3 && text[end - 1] === '0') end -= 1;
  text = text.slice(0, end);
  const have = text.length - point - 1;
  return have < 2 ? text + '0'.repeat(2 - have) : text;
}
