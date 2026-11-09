/**
 * How a received intelligence record is presented. The server sends an English
 * headline and a JSON detail string. The drawer names the record's kind and
 * composes the heading from the record's fields through the locale tables, and it
 * never prints the raw detail: the module panes show the parsed fields they use.
 */

import type { IntelligenceEvent } from '../state/intelligenceStore';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Locale keys of the record kinds the drawer knows. Any other kind shows its raw token. */
const KIND_KEYS: ReadonlyMap<string, string> = new Map([
  ['capitol', 'intel.kind.capitol'],
  ['defense_contract', 'intel.kind.defense_contract'],
  ['sec_diff', 'intel.kind.sec_diff'],
  ['jet_flight', 'intel.kind.jet_flight'],
]);

/** The locale key that names a record kind, or null for a kind the drawer does not know. */
export function intelKindKey(kind: string): string | null {
  return KIND_KEYS.get(kind) ?? null;
}

/** The detail as a JSON object, or an empty object when the detail is not one. */
export function parseIntelDetail(detail: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(detail);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The trade side in the active locale. The server title-cases the House type, so a
 * sale arrives as "Sale", "Sale_Full" or "Sale_Partial", and a purchase as "Purchase".
 */
function tradeSide(type: string | null, t: Translate): string | null {
  if (type === null) return null;
  if (/^sale/i.test(type)) return t('intel.trade.sale');
  if (/^purchase/i.test(type)) return t('intel.trade.purchase');
  return null;
}

/**
 * The heading of a record in the active locale. Congressional trades and defense
 * contracts are composed from their fields. Other kinds show the server headline,
 * which is the only text the drawer has for them.
 */
export function intelHeading(event: IntelligenceEvent, t: Translate): string {
  if (event.kind === 'capitol') {
    const payload = parseIntelDetail(event.detail);
    const who = textField(payload.politician) ?? t('intel.event.politicianUnknown');
    const side = tradeSide(textField(payload.type), t);
    return side === null
      ? t('intel.event.capitolNoSide', { who, symbol: event.symbol })
      : t('intel.event.capitol', { who, side, symbol: event.symbol });
  }
  if (event.kind === 'defense_contract') {
    return t('intel.event.contract', { symbol: event.symbol });
  }
  return event.headline;
}
