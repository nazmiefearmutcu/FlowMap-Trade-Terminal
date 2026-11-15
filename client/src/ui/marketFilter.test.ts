import { describe, expect, it } from 'vitest';

import {
  groupEntry,
  groupState,
  marketFilter,
  marketGroupOf,
  normalizeHiddenMarkets,
  setGroupVisible,
  setMarketVisible,
} from './marketFilter';

describe('marketGroupOf', () => {
  it('sorts every kind of market string into its group', () => {
    expect(marketGroupOf('equity')).toBe('us');
    expect(marketGroupOf('world-xist')).toBe('world');
    expect(marketGroupOf('futures-cme_mini')).toBe('futures');
    expect(marketGroupOf('futures-eurex-official')).toBe('futures');
    expect(marketGroupOf('forex')).toBe('forex');
    expect(marketGroupOf('indices')).toBe('indices');
    expect(marketGroupOf('bonds')).toBe('bonds');
    expect(marketGroupOf('sim')).toBe('sim');
    expect(marketGroupOf('binance-usdm')).toBe('crypto');
    expect(marketGroupOf('KRAKEN')).toBe('crypto');
  });
});

describe('normalizeHiddenMarkets', () => {
  it('keeps market strings and known groups, lowercased and once each', () => {
    expect(normalizeHiddenMarkets(['World-XIST', 'world-xist', 'group:bonds', 'group:nope', '', 'bad market', 7, null]))
      .toEqual(['world-xist', 'group:bonds']);
  });

  it('reads anything that is not a list as nothing switched off', () => {
    expect(normalizeHiddenMarkets(undefined)).toEqual([]);
    expect(normalizeHiddenMarkets('kraken')).toEqual([]);
  });
});

describe('marketFilter', () => {
  it('hides single markets and whole groups, and never the directory scope', () => {
    const filter = marketFilter(['kraken', groupEntry('world')]);
    expect(filter.isVisible('kraken')).toBe(false);
    expect(filter.isVisible('binance-spot')).toBe(true);
    expect(filter.isVisible('world-xist')).toBe(false);
    expect(filter.isVisible('world-new-exchange')).toBe(false);
    expect(filter.isVisible('equity')).toBe(true);
    expect(filter.isVisible('all')).toBe(true);
    expect(filter.isGroupHidden('world')).toBe(true);
    expect(filter.isGroupHidden('crypto')).toBe(false);
  });
});

describe('switching markets and groups', () => {
  const crypto = ['binance-spot', 'binance-usdm', 'kraken'];

  it('switches one market off and on again', () => {
    const off = setMarketVisible([], 'kraken', false);
    expect(off).toEqual(['kraken']);
    expect(setMarketVisible(off, 'kraken', true)).toEqual([]);
  });

  it('turning on one market of a hidden group shows only that market', () => {
    const next = setMarketVisible([groupEntry('crypto')], 'kraken', true, crypto);
    const filter = marketFilter(next);
    expect(filter.isVisible('kraken')).toBe(true);
    expect(filter.isVisible('binance-spot')).toBe(false);
    expect(filter.isVisible('binance-usdm')).toBe(false);
    expect(filter.isGroupHidden('crypto')).toBe(false);
  });

  it('a group switch replaces the single entries of that group only', () => {
    const hidden = ['kraken', 'world-xist'];
    const off = setGroupVisible(hidden, 'crypto', false);
    expect(off).toEqual(['world-xist', groupEntry('crypto')]);
    expect(setGroupVisible(off, 'crypto', true)).toEqual(['world-xist']);
  });

  it('reports a group as all, some or none on', () => {
    expect(groupState(marketFilter([]), 'crypto', crypto)).toBe('all');
    expect(groupState(marketFilter(['kraken']), 'crypto', crypto)).toBe('some');
    expect(groupState(marketFilter(crypto), 'crypto', crypto)).toBe('none');
    expect(groupState(marketFilter([groupEntry('crypto')]), 'crypto', crypto)).toBe('none');
  });
});
