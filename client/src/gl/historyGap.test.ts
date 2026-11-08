import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../i18n';
import { MsgType, type Marker } from '../proto/types';
import { displayHistoryGap, historyGap } from './historyGap';

afterEach(() => {
  setLocale('en');
});

/** A gap marker whose source clock says the right block starts 12.3 s after the left one ends (ns clock). */
function gapMarker(): Marker {
  const payload = {
    left_col: 10,
    right_col: 20,
    left_t0_ns: '1000000000000',
    left_end_t_ns: '2000000000000',
    right_t0_ns: '2012300000000',
  };
  return {
    type: MsgType.MARKER,
    ts_ns: 0n,
    kind: 'gap',
    text: `history-gap:v1 ${JSON.stringify(payload)}`,
    price: null,
    size: null,
  };
}

describe('history gap marker', () => {
  it('reads the source-clock fields of a well-formed gap marker', () => {
    const gap = historyGap(gapMarker());
    expect(gap).not.toBeNull();
    expect(gap?.leftCol).toBe(10);
    expect(gap?.rightCol).toBe(20);
  });

  it('passes an unrelated marker through unchanged', () => {
    const plain: Marker = { ...gapMarker(), text: 'plain note' };
    expect(displayHistoryGap(plain)).toBe(plain);
  });

  it('labels the gap in English with a dot decimal', () => {
    setLocale('en');
    expect(displayHistoryGap(gapMarker()).text).toBe('GAP 12.3 s');
  });

  it('labels the gap in Turkish with a comma decimal and the Turkish word and unit', () => {
    setLocale('tr');
    expect(displayHistoryGap(gapMarker()).text).toBe('BOŞLUK 12,3 sn');
  });
});
