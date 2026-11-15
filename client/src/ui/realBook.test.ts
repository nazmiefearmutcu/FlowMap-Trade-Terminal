import { describe, expect, it } from 'vitest';

import { realBookOf } from './realBook';

describe('realBookOf', () => {
  it('reads the real book a synthetic instrument points at', () => {
    expect(realBookOf({ depth: 'SYNTH', real_book: { market: 'kraken', symbol: 'EUR/USD', kind: 'spot' } }))
      .toEqual({ market: 'kraken', symbol: 'EUR/USD', kind: 'spot' });
    expect(realBookOf({ real_book: { market: 'binance-usdm', symbol: 'XAUUSDT', kind: 'perpetual' } }))
      .toEqual({ market: 'binance-usdm', symbol: 'XAUUSDT', kind: 'perpetual' });
  });

  it('is null when the capability names none', () => {
    expect(realBookOf(null)).toBeNull();
    expect(realBookOf(undefined)).toBeNull();
    expect(realBookOf({ depth: 'L2' })).toBeNull();
    expect(realBookOf({ real_book: null })).toBeNull();
  });

  it.each([
    ['a string', 'kraken:EUR/USD'],
    ['no symbol', { market: 'kraken', kind: 'spot' }],
    ['an unknown kind', { market: 'kraken', symbol: 'EUR/USD', kind: 'dark pool' }],
    ['a market with a space', { market: 'kra ken', symbol: 'EUR/USD', kind: 'spot' }],
    ['a symbol with markup', { market: 'kraken', symbol: '<b>EUR</b>', kind: 'spot' }],
    ['numbers', { market: 1, symbol: 2, kind: 'spot' }],
  ])('refuses %s', (_label, raw) => {
    expect(realBookOf({ real_book: raw })).toBeNull();
  });
});
