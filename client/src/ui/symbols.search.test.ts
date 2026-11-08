/**
 * Symbol search matching is Unicode-normalized: a composed and a
 * decomposed spelling of the same name match each other, and Turkish capital
 * dotted İ matches its plain I form.
 */

import { describe, expect, it } from 'vitest';

import { filterSymbols, searchKey, type SymbolEntry } from './symbols';

const ENTRIES = [
  { symbol: 'İZMİR-INDEX', market: 'bist', capability: {} },
  { symbol: 'CAFÉ-TOKEN', market: 'kraken', capability: {} },
  { symbol: 'BTCUSDT', market: 'binance-usdm', capability: {} },
] as unknown as SymbolEntry[];

describe('searchKey', () => {
  it('drops combining marks so composed and decomposed text compare equal', () => {
    expect(searchKey('CAFÉ')).toBe(searchKey('CAFÉ'));
  });

  it('folds Turkish dotted capital İ onto plain i', () => {
    expect(searchKey('İz')).toBe('iz');
  });
});

describe('filterSymbols with normalized matching', () => {
  it('matches a decomposed query against a composed symbol', () => {
    expect(filterSymbols(ENTRIES, 'café').map((e) => e.symbol)).toEqual(['CAFÉ-TOKEN']);
  });

  it('matches the plain query against an İ symbol', () => {
    expect(filterSymbols(ENTRIES, 'iz').map((e) => e.symbol)).toEqual(['İZMİR-INDEX']);
  });

  it('keeps the ordinary ASCII behaviour', () => {
    expect(filterSymbols(ENTRIES, 'btc').map((e) => e.symbol)).toEqual(['BTCUSDT']);
    expect(filterSymbols(ENTRIES, '   ')).toHaveLength(3);
  });
});
