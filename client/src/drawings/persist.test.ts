/**
 * Persistence tests: versioned localStorage documents — exact
 * bigint round-trip through decimal strings, total parsing (garbage reads as
 * empty), wholesale future-version rejection, entry-wise validation, and the
 * bounded per-symbol cap (200, newest kept).
 */

import { describe, expect, it } from 'vitest';

import {
  DRAWINGS_SCHEMA_VERSION,
  MAX_DRAWINGS_PER_SYMBOL,
  drawingsKey,
  hasDrawingRoom,
  loadDrawings,
  parseDoc,
  saveDrawings,
  serializeDoc,
  type StorageLike,
} from './persist';
import { DEFAULT_STYLE } from './types';
import type { DrawingsDoc } from './types';
import type { ChartPoint, Drawing } from './types';

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const P = (t: bigint, price: number): ChartPoint => ({ tNs: t, price });
const trend = (id: string, createdAt: number): Drawing => ({
  id,
  tool: 'trendline',
  createdAt,
  points: [P(1_000_000_000_000n, 101.5), P(2_000_000_000_000n, 99.25)],
  style: { ...DEFAULT_STYLE },
});
const label = (id: string): Drawing => ({
  id,
  tool: 'text',
  createdAt: 5,
  points: [P(0n, 1)],
  style: { ...DEFAULT_STYLE },
  text: 'wall',
});

describe('key + doc shape', () => {
  it('namespaces per market:symbol under the flowmap.drawings prefix', () => {
    expect(drawingsKey('crypto', 'BTCUSDT')).toBe('flowmap.drawings.v1.crypto.BTCUSDT');
  });

  it('serializes bigints as decimal strings and parses them back EXACTLY', () => {
    const doc: DrawingsDoc = { version: DRAWINGS_SCHEMA_VERSION, drawings: [trend('a', 1)] };
    const raw = serializeDoc(doc);
    expect(raw).toContain('"tNs":"1000000000000"'); // string in JSON — a number would corrupt epoch ns
    const out = parseDoc(raw);
    expect(out.length).toBe(1);
    const d0 = out[0] as Drawing;
    expect(d0.points[0].tNs).toBe(1_000_000_000_000n);
    expect(d0.points[1]!.price).toBe(99.25);
  });
});

describe('parseDoc is total', () => {
  it('reads null / empty / garbage as an empty list, never throws', () => {
    expect(parseDoc(null)).toEqual([]);
    expect(parseDoc('')).toEqual([]);
    expect(parseDoc('{not json')).toEqual([]);
    expect(parseDoc('42')).toEqual([]);
    expect(parseDoc('{"version":1}')).toEqual([]); // missing drawings
  });

  it('rejects past AND future schema versions wholesale', () => {
    expect(parseDoc('{"version":2,"drawings":[]}')).toEqual([]);
    expect(parseDoc('{"version":0,"drawings":[]}')).toEqual([]);
  });

  it('drops invalid entries while valid siblings survive', () => {
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: [
        trend('good', 1),
        { id: 'bad-tool', tool: 'lightsaber', createdAt: 1, points: [], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-arity', tool: 'rect', createdAt: 1, points: [P(0n, 1)], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-nan', tool: 'hline', createdAt: 1, points: [{ tNs: '0', price: Number.NaN }], style: DEFAULT_STYLE } as unknown as Drawing,
        { id: 'bad-style', tool: 'hline', createdAt: 1, points: [P(0n, 1)], style: { color: 7, width: 2 } } as unknown as Drawing,
        { ...label('bad-text'), text: 42 } as unknown as Drawing,
      ],
    });
    const out = parseDoc(raw);
    expect(out.map((d) => d.id)).toEqual(['good']);
  });

  it('keeps a valid text payload through the round-trip', () => {
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: [label('t')],
    });
    expect(parseDoc(raw)[0]).toMatchObject({ tool: 'text', text: 'wall' });
  });
});

describe('limit (bounded 200/symbol, refuses instead of evicting)', () => {
  it('refuses a placement at the limit and admits one below it', () => {
    expect(hasDrawingRoom(MAX_DRAWINGS_PER_SYMBOL - 1)).toBe(true);
    expect(hasDrawingRoom(MAX_DRAWINGS_PER_SYMBOL)).toBe(false);
    expect(hasDrawingRoom(MAX_DRAWINGS_PER_SYMBOL + 5)).toBe(false);
  });

  it('keeps every stored drawing on load, even above the limit (no silent eviction)', () => {
    const items: Drawing[] = [];
    for (let i = 0; i < MAX_DRAWINGS_PER_SYMBOL + 1; i += 1) items.push(trend(`d${i}`, i));
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: items,
    });
    const loaded = parseDoc(raw);
    expect(loaded.length).toBe(MAX_DRAWINGS_PER_SYMBOL + 1);
    expect(loaded[0].id).toBe('d0'); // the oldest is still there
  });

  it('saves every drawing rather than trimming the oldest', () => {
    const st = memStorage();
    const items: Drawing[] = [];
    for (let i = 0; i < MAX_DRAWINGS_PER_SYMBOL + 2; i += 1) items.push(trend(`d${i}`, i));
    saveDrawings(st, 'crypto', 'BTC', items);
    expect(loadDrawings(st, 'crypto', 'BTC').map((d) => d.id)).toEqual(items.map((d) => d.id));
  });
});

describe('digit-only text labels', () => {
  it('a 13+ digit label survives a reload as text and the drawing is kept', () => {
    const base = label('n');
    if (base.tool !== 'text') throw new Error('fixture must be a text label');
    const raw = serializeDoc({
      version: DRAWINGS_SCHEMA_VERSION,
      drawings: [{ ...base, text: '12345678901234' }],
    });
    const [d] = parseDoc(raw);
    expect(d).toMatchObject({ tool: 'text', text: '12345678901234' });
  });

  it('epoch tNs strings still revive to exact bigints', () => {
    const raw = serializeDoc({ version: DRAWINGS_SCHEMA_VERSION, drawings: [trend('a', 1)] });
    const [d] = parseDoc(raw);
    expect(d.points[0].tNs).toBe(1_000_000_000_000n);
  });
});

describe('load/save', () => {
  it('round-trips through a storage double, scoped per symbol', () => {
    const st = memStorage();
    saveDrawings(st, 'crypto', 'BTC', [trend('a', 1)]);
    expect(loadDrawings(st, 'crypto', 'BTC').length).toBe(1);
    expect(loadDrawings(st, 'crypto', 'ETH')).toEqual([]); // other symbol unaffected
  });

  it('saving an EMPTY document removes the key (no zombie docs)', () => {
    const st = memStorage();
    saveDrawings(st, 'crypto', 'BTC', [trend('a', 1)]);
    saveDrawings(st, 'crypto', 'BTC', []);
    expect(st.map.has(drawingsKey('crypto', 'BTC'))).toBe(false);
    expect(loadDrawings(st, 'crypto', 'BTC')).toEqual([]);
  });

  it('null storage is a no-op (session-local mode)', () => {
    expect(() => saveDrawings(null, 'm', 's', [trend('a', 1)])).not.toThrow();
    expect(loadDrawings(null, 'm', 's')).toEqual([]);
  });
});
