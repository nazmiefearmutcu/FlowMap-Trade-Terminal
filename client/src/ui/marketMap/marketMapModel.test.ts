import { describe, expect, it } from 'vitest';

import type { MapItem } from './marketMapApi';
import {
  CLAMP_PERCENT,
  DEFAULT_PERIOD,
  PERIODS,
  changeLevel,
  formatChange,
  formatCompact,
  labelFor,
  tileTone,
  toGroups,
} from './marketMapModel';

function item(overrides: Partial<MapItem> & Pick<MapItem, 'symbol' | 'group' | 'marketCap'>): MapItem {
  return {
    name: overrides.symbol,
    price: 1,
    change: {},
    volume: null,
    chart: null,
    ...overrides,
  };
}

describe('periods and clamps', () => {
  it('lists the periods per market, with the default first', () => {
    expect(PERIODS.us).toEqual(['1d']);
    expect(PERIODS.crypto).toEqual(['1h', '24h', '7d']);
    expect(DEFAULT_PERIOD.us).toBe('1d');
    expect(DEFAULT_PERIOD.crypto).toBe('24h');
  });

  it('clamps each period at its own percent', () => {
    expect(CLAMP_PERCENT).toEqual({ '1d': 3, '1h': 2, '24h': 10, '7d': 20 });
  });
});

describe('changeLevel', () => {
  it('is null when the change is unknown', () => {
    expect(changeLevel(undefined, '1d')).toBeNull();
    expect(changeLevel(Number.NaN, '1d')).toBeNull();
    expect(changeLevel(Number.POSITIVE_INFINITY, '1d')).toBeNull();
  });

  it('divides by the period clamp', () => {
    expect(changeLevel(1.5, '1d')).toBeCloseTo(0.5);
    expect(changeLevel(-5, '24h')).toBeCloseTo(-0.5);
  });

  it('limits the level to minus one and one', () => {
    expect(changeLevel(9, '1d')).toBe(1);
    expect(changeLevel(-9, '1d')).toBe(-1);
    expect(changeLevel(3, '1d')).toBe(1);
    expect(changeLevel(-3, '1d')).toBe(-1);
  });

  it('is zero for a zero change', () => {
    expect(changeLevel(0, '7d')).toBe(0);
  });
});

describe('tileTone', () => {
  it('is unknown with no strength for a null level', () => {
    expect(tileTone(null)).toEqual({ side: 'unknown', strength: 0 });
  });

  it('is flat below the 0.02 threshold, either side', () => {
    expect(tileTone(0)).toEqual({ side: 'flat', strength: 0 });
    expect(tileTone(0.019)).toEqual({ side: 'flat', strength: 0 });
    expect(tileTone(-0.019)).toEqual({ side: 'flat', strength: 0 });
  });

  it('starts the stepped strength at the threshold', () => {
    expect(tileTone(0.02)).toEqual({ side: 'up', strength: 0.2 });
    expect(tileTone(-0.02)).toEqual({ side: 'down', strength: 0.2 });
  });

  it('rounds the strength up to the next of five steps', () => {
    expect(tileTone(0.2)).toEqual({ side: 'up', strength: 0.2 });
    expect(tileTone(0.21)).toEqual({ side: 'up', strength: 0.4 });
    expect(tileTone(0.4)).toEqual({ side: 'up', strength: 0.4 });
    expect(tileTone(-0.61)).toEqual({ side: 'down', strength: 0.8 });
    expect(tileTone(-0.8)).toEqual({ side: 'down', strength: 0.8 });
    expect(tileTone(0.81)).toEqual({ side: 'up', strength: 1 });
    expect(tileTone(1)).toEqual({ side: 'up', strength: 1 });
    expect(tileTone(-1)).toEqual({ side: 'down', strength: 1 });
  });
});

describe('toGroups', () => {
  it('makes one group per sector, with the symbol as id and the market value as value', () => {
    const groups = toGroups([
      item({ symbol: 'NVDA', group: 'Technology', marketCap: 3e12 }),
      item({ symbol: 'XOM', group: 'Energy', marketCap: 4e11 }),
      item({ symbol: 'AAPL', group: 'Technology', marketCap: 3.5e12 }),
    ]);

    expect(groups).toEqual([
      {
        id: 'Technology',
        items: [
          { id: 'NVDA', value: 3e12 },
          { id: 'AAPL', value: 3.5e12 },
        ],
      },
      { id: 'Energy', items: [{ id: 'XOM', value: 4e11 }] },
    ]);
  });

  it('returns no groups for no items', () => {
    expect(toGroups([])).toEqual([]);
  });
});

describe('labelFor', () => {
  it('shows no text under 28 by 14 px', () => {
    expect(labelFor({ x: 0, y: 0, w: 27, h: 100 })).toBe('none');
    expect(labelFor({ x: 0, y: 0, w: 100, h: 13 })).toBe('none');
    expect(labelFor({ x: 0, y: 0, w: 28, h: 14 })).toBe('symbol');
  });

  it('shows the symbol only under 44 by 30 px', () => {
    expect(labelFor({ x: 0, y: 0, w: 43, h: 100 })).toBe('symbol');
    expect(labelFor({ x: 0, y: 0, w: 100, h: 29 })).toBe('symbol');
    expect(labelFor({ x: 0, y: 0, w: 44, h: 30 })).toBe('symbol+change');
  });
});

describe('formatChange', () => {
  it('signs the change with one decimal and a real minus sign', () => {
    expect(formatChange(1.23)).toBe('+1.2%');
    expect(formatChange(-3.44)).toBe('\u22123.4%');
    expect(formatChange(0)).toBe('0.0%');
  });
});

describe('formatCompact', () => {
  it('uses the T, B, M and K suffixes', () => {
    expect(formatCompact(3.9e12)).toBe('3.9T');
    expect(formatCompact(4.88e10)).toBe('48.8B');
    expect(formatCompact(9393915)).toBe('9.4M');
    expect(formatCompact(2500)).toBe('2.5K');
    expect(formatCompact(950)).toBe('950');
  });

  it('steps up a unit when rounding reaches 1000', () => {
    expect(formatCompact(999_960_000_000)).toBe('1T');
  });
});
