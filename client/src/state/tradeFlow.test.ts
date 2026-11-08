import { expect, it } from 'vitest';
import { MsgType, SIDE_BUY, SIDE_SELL, SIDE_UNKNOWN, SIDE_SRC_EXCHANGE, SIDE_SRC_INFERRED, SIDE_SRC_NA, type Trade } from '../proto/types';
import { TradeFlowAccumulator } from './tradeFlow';
const print = (ms: number, size = 1, side = SIDE_BUY, src = SIDE_SRC_EXCHANGE): Trade => ({
  type: MsgType.TRADE, ts_ns: BigInt(ms) * 1_000_000n, price: 100, size, side, side_src: src, venue: 'test',
});
it('counts more prints than the display tape retains and preserves real duplicate prints', () => {
  const flow = new TradeFlowAccumulator();
  for (let i = 0; i < 10_000; i++) flow.ingest(print(1000, 0.25), 1000);
  expect(flow.summary(5000, 1000)).toMatchObject({ count: 10_000, buy: 2500, delta: 2500, notional: 250000 });
});
it('keeps unknown sides out of delta and reports inferred classifications separately', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000, 3), 1000);
  flow.ingest(print(1100, 2, SIDE_SELL, SIDE_SRC_INFERRED), 1100);
  flow.ingest(print(1200, 4, SIDE_UNKNOWN, SIDE_SRC_NA), 1200);
  flow.ingest(print(1300, 5, SIDE_BUY, SIDE_SRC_NA), 1300);
  expect(flow.summary(5000, 1300)).toMatchObject({ buy: 3, sell: 2, unknown: 9, delta: 1, exchange: 1, inferred: 1 });
});
it('ages quiet live flow, freezes replay time and accepts in-window out-of-order prints', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000), 1000); flow.ingest(print(3000), 3000); flow.ingest(print(2000, 2), 3500);
  expect(flow.summary(5000, 3500).count).toBe(3);
  expect(flow.summary(5000, 9000).count).toBe(0);
  expect(flow.summary(5000, 9000, true).count).toBe(3);
});
it('reuses bounded bins without leaking an overwritten minute into the next', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000, 100), 0); flow.ingest(print(121000, 2), 100);
  flow.ingest(print(1000, 99), 100);
  expect(flow.summary(60000, 100)).toMatchObject({ buy: 2, count: 1 });
});
it('a sustained rewind (replay seek) starts a new timeline instead of freezing the summary', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(120_000, 1), 0); // the replay head before the seek
  // The seek lands 100 s back. The first prints are ignored like any stale print…
  flow.ingest(print(20_000, 1), 1);
  flow.ingest(print(20_100, 1), 2);
  // …but the stream keeps rewinding, so the window is rebuilt around the new head.
  flow.ingest(print(20_200, 3), 3);
  flow.ingest(print(20_300, 4), 4);
  // The rebuilt window holds only the new timeline's prints (the old head is gone).
  expect(flow.summary(60_000, 4, true)).toMatchObject({ buy: 7, count: 2 });
});
it('a single late print far behind the window never wipes it', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(120_000, 1), 0);
  flow.ingest(print(120_050, 1), 1);
  flow.ingest(print(20_000, 9), 2); // one stale print
  flow.ingest(print(120_100, 1), 3); // back in the live window: the run is broken
  expect(flow.summary(60_000, 3)).toMatchObject({ buy: 3, count: 3 });
});
it('resets instrument/session data and rejects invalid quantities and overflow', () => {
  const flow = new TradeFlowAccumulator(); flow.ingest(print(1000), 1000);
  flow.reset(); flow.ingest(print(2000, -3), 2000); flow.ingest(print(2000, Infinity), 2000);
  expect(flow.summary(60000, 2000).count).toBe(0);
});

it('returns the same summary object while nothing in the window changes', () => {
  const flow = new TradeFlowAccumulator();
  flow.ingest(print(1000, 2), 1000);
  const first = flow.summary(5000, 1000);
  expect(flow.summary(5000, 1000)).toBe(first);
  flow.ingest(print(1000, 1), 1000);
  const second = flow.summary(5000, 1000);
  expect(second).not.toBe(first);
  expect(second).toMatchObject({ buy: 3, count: 2 });
});

it('keeps an empty summary stable across idle polls', () => {
  const flow = new TradeFlowAccumulator();
  expect(flow.summary(5000, 1000)).toBe(flow.summary(5000, 2000));
});
