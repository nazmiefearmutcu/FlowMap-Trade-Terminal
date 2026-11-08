import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../i18n';
import { Bbo, type BboState } from './bbo';
import { GridMap, type TimeMap } from './coords';
import type { OverlayFrame } from './frame';

const DIMS = { drawW: 800, drawH: 400, cssW: 800, cssH: 400 };
const TIME: TimeMap = { anchorSeq: 5, anchorT0Ns: 1_250_000_000n, dtNs: 250_000_000 };
const VIEW = { colOffset: 0, colScale: 10, rowOffset: 0, rowScale: 100 };

/** A frame whose text layer records every badge label instead of painting. */
function recordingFrame(): { frame: OverlayFrame; labels: string[] } {
  const labels: string[] = [];
  const gm = new GridMap(VIEW, DIMS, TIME, { p0: 100, step: 0.25, tick: 0.25 });
  const solid = { begin: () => {}, addThickLine: () => {}, flush: () => {} };
  const text = {
    badge: (_x: number, _y: number, label: string) => {
      labels.push(label);
    },
  };
  return { frame: { gm, solid, text } as unknown as OverlayFrame, labels };
}

function drawWith(state: Partial<BboState>): string[] {
  const { frame, labels } = recordingFrame();
  const bbo = new Bbo();
  bbo.set({ bidPx: 100.25, bidSz: 1, askPx: 100.75, askSz: 1, source: 'bbo', ...state });
  bbo.draw(frame);
  return labels;
}

afterEach(() => {
  setLocale('en');
});

describe('BBO size badge', () => {
  it('never prints a positive size as 0.00', () => {
    const labels = drawWith({ bidSz: 0.004 });
    expect(labels.find((l) => l.startsWith('B '))).toBe('B 100.25 ×<0.01');
  });

  it('rolls 999.96 up to the next unit instead of 1000.0', () => {
    const labels = drawWith({ askSz: 999.96 });
    expect(labels.find((l) => l.startsWith('A '))).toBe('A 100.75 ×1K');
  });

  it('formats the size with the UI locale decimal separator, keeping prices on a dot', () => {
    setLocale('tr');
    const labels = drawWith({ askSz: 1.25, bidSz: 0.5 });
    expect(labels.find((l) => l.startsWith('S '))).toBe('S 100.75 ×1,25');
    expect(labels.find((l) => l.startsWith('A '))).toBe('A 100.25 ×0,50');
  });

  it('uses the locale side letters: bid is A (Alış) and ask is S (Satış) in Turkish', () => {
    setLocale('tr');
    expect(drawWith({})).toEqual(['S 100.75 ×1,00', 'A 100.25 ×1,00']);
  });

  it('shows a zero size as 0 and a missing size as an em dash, never a blank', () => {
    expect(drawWith({ bidSz: 0, askSz: 0 })).toEqual(['A 100.75 ×0', 'B 100.25 ×0']);
    expect(drawWith({ askSz: Number.NaN })[0]).toBe('A 100.75 ×—');
    expect(drawWith({ askSz: Number.POSITIVE_INFINITY })[0]).toBe('A 100.75 ×∞');
  });

  it('tags a book-derived quote with the L2 marker', () => {
    const labels = drawWith({ source: 'l2', askSz: 8 });
    expect(labels.find((l) => l.startsWith('A '))).toBe('A 100.75 ×8.00 ·L2');
  });
});
