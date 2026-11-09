import { afterEach, describe, expect, it } from 'vitest';

import { setLocale, t } from '../i18n';
import type { IntelligenceEvent } from '../state/intelligenceStore';
import { intelHeading, intelKindKey, parseIntelDetail } from './IntelligenceDrawerEvents';

function event(overrides: Partial<IntelligenceEvent>): IntelligenceEvent {
  return {
    id: 'received-1-1',
    symbol: 'NVDA',
    kind: 'capitol',
    headline: 'Server headline',
    detail: '{}',
    fields: {},
    source: 'House',
    tsNs: 1n,
    ...overrides,
  };
}

afterEach(() => setLocale('en'));

describe('intelKindKey', () => {
  it('names the kinds the drawer knows and returns null for any other token', () => {
    expect(intelKindKey('capitol')).toBe('intel.kind.capitol');
    expect(intelKindKey('defense_contract')).toBe('intel.kind.defense_contract');
    expect(intelKindKey('unknown_kind')).toBeNull();
    expect(intelKindKey('toString')).toBeNull();
  });
});

describe('parseIntelDetail', () => {
  it('reads a JSON object and treats anything else as no fields', () => {
    expect(parseIntelDetail('{"politician":"Jane Roe"}')).toEqual({ politician: 'Jane Roe' });
    expect(parseIntelDetail('[1,2]')).toEqual({});
    expect(parseIntelDetail('null')).toEqual({});
    expect(parseIntelDetail('Plain text')).toEqual({});
  });
});

describe('intelHeading', () => {
  it('composes a congressional trade heading from its fields in each locale', () => {
    const sale = event({ detail: '{"politician":"Jane Roe","type":"Sale"}' });
    expect(intelHeading(sale, t)).toBe('Jane Roe: SALE in NVDA');
    setLocale('tr');
    expect(intelHeading(sale, t)).toBe('Jane Roe: NVDA SATIŞ');
  });

  it('reads the side from the title-cased House types the server sends', () => {
    const partial = event({ detail: '{"politician":"Jane Roe","type":"Sale_Partial"}' });
    expect(intelHeading(partial, t)).toBe(`Jane Roe: ${t('intel.trade.sale')} in NVDA`);
    const buy = event({ detail: '{"politician":"Jane Roe","type":"Purchase"}' });
    expect(intelHeading(buy, t)).toBe(`Jane Roe: ${t('intel.trade.purchase')} in NVDA`);
    const exchange = event({ detail: '{"politician":"Jane Roe","type":"Exchange"}' });
    expect(intelHeading(exchange, t)).toBe('Jane Roe: trade in NVDA');
  });

  it('names a missing politician and a missing side without echoing the server headline', () => {
    expect(intelHeading(event({ detail: '{}' }), t)).toBe('Representative not named: trade in NVDA');
  });

  it('composes a defense contract heading in each locale', () => {
    const award = event({ kind: 'defense_contract', headline: 'NVDA contract award', detail: '{"award_id":"A1"}' });
    expect(intelHeading(award, t)).toBe('NVDA federal contract award');
    setLocale('tr');
    expect(intelHeading(award, t)).toBe('NVDA federal sözleşme ödülü');
  });

  it('falls back to the server headline for kinds without a composed heading', () => {
    expect(intelHeading(event({ kind: 'sec_diff', headline: 'Filing changed' }), t)).toBe('Filing changed');
  });
});
