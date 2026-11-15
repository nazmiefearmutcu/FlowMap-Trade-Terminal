import { describe, expect, it, vi } from 'vitest';
import type { BarColumn } from '../../proto/types';
import type { OverlayFrame } from './frame';
import { NativeCandles } from './nativeCandles';
import { OVERLAY } from './palette';

function bar(seq: number, close = 101, cumulative = 7): BarColumn {
  return { col_seq: seq, o: 100, h: 105, l: 99, c: close,
    vwap_den_cum: cumulative, vol_buy: 0, vol_sell: 0 } as BarColumn;
}

function frame() {
  const rect = vi.fn();
  const text = vi.fn();
  const value = { gm: { hasEvents: true, view: { colOffset: 0, colScale: 20 },
    cssX: (col: number) => col * 10, cssY: (row: number) => 200 - row,
    priceEventToRow: (price: number) => price }, text: { rect, text },
    resident: { oldest: 0, newest: 20 } } as unknown as OverlayFrame;
  return { value, rect, text };
}

describe('official candle drawing', () => {
  it('draws actual OHLC wick/body and leaves missing minutes empty', () => {
    const candles = new NativeCandles();
    candles.add(bar(1));
    candles.add(bar(3, 98, 11));
    candles.add(bar(4, Number.NaN));
    const f = frame();
    candles.draw(f.value);
    expect(f.rect).toHaveBeenCalledTimes(4);
    expect(f.rect.mock.calls[0].slice(0, 4)).toEqual([14.5, 95, 1, 6]);
    expect(f.rect.mock.calls[2][0]).toBe(34.5);
  });

  it('replaces repeated source candles and clears removed candles on snapshot reset', () => {
    const candles = new NativeCandles();
    candles.add(bar(1)); candles.add(bar(1, 102));
    const f = frame();
    candles.draw(f.value);
    expect(f.rect).toHaveBeenCalledTimes(2);
    candles.reset(); f.rect.mockClear();
    candles.draw(f.value);
    expect(f.rect).not.toHaveBeenCalled();
  });

  it('uses neutral publisher quantity independently of unavailable side volume', () => {
    const candles = new NativeCandles();
    candles.add(bar(0, 101, 7)); candles.add(bar(1, 102, 11));
    const f = frame();
    candles.drawVolume(f.value, 40);
    expect(f.rect).toHaveBeenCalledTimes(2);
    expect(f.rect.mock.calls.every(args => args[4] === OVERLAY.unknown.css)).toBe(true);
    expect(f.text.mock.calls[0][2]).toContain('side unknown');
    expect(f.rect.mock.calls[1][3] / f.rect.mock.calls[0][3]).toBeCloseTo(4 / 7);
  });

  it('omits a truncated prefix whose preceding cumulative baseline is unavailable', () => {
    const candles = new NativeCandles();
    candles.add(bar(0, 101, 100)); candles.add(bar(1, 101, 107)); candles.add(bar(2, 102, 111));
    candles.prune(1, 2, 0);
    const f = frame();
    candles.drawVolume(f.value, 40);
    expect(f.rect).toHaveBeenCalledTimes(1);
    expect(f.rect.mock.calls[0][0]).toBe(21.5);
  });
});
