/** Published native OHLC candles; neutral volume is publisher quantity, never side volume. */
import { t } from '../../i18n';
import type { BarColumn } from '../../proto/types';
import { visibleColRange } from './coords';
import type { OverlayFrame } from './frame';
import { OVERLAY } from './palette';

export class NativeCandles {
  private readonly bars = new Map<number, BarColumn>();

  add(bar: BarColumn): void { this.bars.set(bar.col_seq, bar); }
  reset(): void { this.bars.clear(); }
  prune(oldest: number, newest: number, pad = 64): void {
    for (const col of this.bars.keys()) if (col < oldest - pad || col > newest + pad) this.bars.delete(col);
  }

  draw(frame: OverlayFrame): void {
    const { gm, text } = frame;
    const range = visibleColRange(gm.view, frame.resident);
    if (!range || !gm.hasEvents) return;
    const width = Math.max(1, Math.min(14, Math.abs(gm.cssX(1) - gm.cssX(0)) * .7));
    for (let col = range.lo; col <= range.hi; col++) {
      const bar = this.bars.get(col);
      if (!bar || ![bar.o, bar.h, bar.l, bar.c].every(Number.isFinite)) continue;
      const x = gm.cssX(col + .5);
      const y = (price: number) => gm.cssY(gm.priceEventToRow(price));
      // Up/down colour denotes close versus open; no aggressor inference.
      const color = bar.c >= bar.o ? OVERLAY.buy.css : OVERLAY.sell.css;
      text.rect(x - .5, y(bar.h), 1, Math.max(1, y(bar.l) - y(bar.h)), color);
      text.rect(x - width / 2, Math.min(y(bar.o), y(bar.c)), width,
        Math.max(1, Math.abs(y(bar.o) - y(bar.c))), color);
    }
  }

  drawVolume(frame: OverlayFrame, height: number): void {
    const { gm, text } = frame;
    const range = visibleColRange(gm.view, frame.resident);
    if (!range) return;
    const points = [...this.bars.values()].sort((a, b) => a.col_seq - b.col_seq);
    const quantities = points.map((bar, i) => {
      const previous = points[i - 1];
      const baseline = bar.col_seq === 0 ? 0 : previous?.col_seq === bar.col_seq - 1 ? previous.vwap_den_cum : Number.NaN;
      return { col: bar.col_seq, volume: Math.max(0, bar.vwap_den_cum - baseline) };
    });
    const max = Math.max(0, ...quantities.filter(p => p.volume > 0 && p.col >= range.lo && p.col <= range.hi).map(p => p.volume));
    if (!(max > 0)) return;
    const width = Math.max(1, Math.min(14, Math.abs(gm.cssX(1) - gm.cssX(0)) * .7));
    for (const point of quantities) {
      if (point.col < range.lo || point.col > range.hi || !(point.volume > 0)) continue;
      const h = Math.max(1, point.volume / max * (height - 12));
      text.rect(gm.cssX(point.col + .5) - width / 2, height - h, width, h, OVERLAY.unknown.css);
    }
    text.text(8, 10, t('eurex.quantity'), { color: OVERLAY.axis.css, size: 12 });
  }
}
