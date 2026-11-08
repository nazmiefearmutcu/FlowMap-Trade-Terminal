/**
 * Nanosecond fields as bigint. The binary decoder yields bigint for ns-scale
 * timestamps, but a cold JSON payload can carry a small integer as a number, so
 * the stores accept both and normalise here.
 */

/**
 * Coerce a canonical ns field to bigint. A non-finite number has no timestamp
 * meaning and maps to 0n. A fractional number is rounded to the nearest ns. A
 * number beyond 2^53 has already lost its low digits before it arrives, so
 * this path is for small integers only; the binary decoder yields bigint.
 */
export function toBigNs(x: bigint | number): bigint {
  if (typeof x === 'bigint') return x;
  if (!Number.isFinite(x)) return 0n;
  return BigInt(Math.round(x));
}
