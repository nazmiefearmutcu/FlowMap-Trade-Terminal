import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BookSnapshot } from '../state/bookStore';
import {
  atmStrike,
  chartPrice,
  daysToExpiry,
  decimalsOf,
  expiryMs,
  fetchOptionChain,
  hasActivity,
  hasOptionChains,
  midDeltaStrike,
  moneyBand,
  optionChainErrorKey,
  optionChainPath,
  OptionChainRequestError,
  parseOptionChain,
  premiumDecimals,
  referencePrice,
  seriesKey,
  spotDecimals,
  strikeDecimals,
  visibleDecimals,
  type OptionSide,
  type OptionStrike,
} from './optionChainModel';

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = Date.UTC(2026, 10, 12, 15, 0, 0); // 2026-11-12 15:00 UTC

function side(symbol: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { symbol, bid: 1.5, ask: 1.6, theo: 1.55, iv: 0.25, delta: 0.5, gamma: 0.02, theta: -0.1, vega: 0.2, rho: 0.03, ...extra };
}

function goodBody(): Record<string, unknown> {
  return {
    market: 'equity',
    symbol: 'AAPL',
    status: 'ok',
    underlying: 'NASDAQ:AAPL',
    series: [
      { root: 'AAPL', expiry: '2026-11-13', contracts: 40 },
      { root: 'AAPL', expiry: '2026-11-20', contracts: 36 },
    ],
    selected: { root: 'AAPL', expiry: '2026-11-13' },
    strikes: [
      { strike: 110, call: side('OPRA:AAPL261113C110'), put: side('OPRA:AAPL261113P110') },
      { strike: 100, call: side('OPRA:AAPL261113C100'), put: side('OPRA:AAPL261113P100') },
    ],
    capturedMs: 1_700_000_000_000,
    stale: false,
    source: 'tradingview',
  };
}

function strike(value: number): OptionStrike {
  return { strike: value, call: null, put: null };
}

function contract(over: Partial<OptionSide> = {}): OptionSide {
  return {
    symbol: 'X', bid: null, bidSize: null, ask: null, askSize: null, last: null, theo: null, iv: null,
    volume: null, openInterest: null, delta: null, gamma: null, theta: null, vega: null, rho: null, ...over,
  };
}

/** A strike whose call states the given quote fields. */
function quoted(value: number, over: Partial<OptionSide>): OptionStrike {
  return { strike: value, call: contract(over), put: null };
}

function fakeResponse(status: number, body: string): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response;
}

describe('hasOptionChains', () => {
  it.each(['equity', 'world-xist', 'indices', 'forex', 'bonds', 'futures-eurex', 'binance', 'binance-usdm', 'deribit', 'kraken'])(
    'is true for %s',
    (market) => {
      expect(hasOptionChains(market)).toBe(true);
    },
  );

  it.each(['sim', '', '  '])('is false for %j: the sim feed and no market have no instrument to chain', (market) => {
    expect(hasOptionChains(market)).toBe(false);
  });

  it('ignores the case of the market name', () => {
    expect(hasOptionChains('EQUITY')).toBe(true);
    expect(hasOptionChains('SIM')).toBe(false);
  });
});

describe('optionChainPath', () => {
  it('encodes the index symbol and keeps the bang of a futures root', () => {
    expect(optionChainPath('indices', 'SP:SPX')).toBe('/api/options?market=indices&symbol=SP%3ASPX');
    expect(optionChainPath('futures-cme', 'ES1!')).toBe('/api/options?market=futures-cme&symbol=ES1!');
  });

  it('adds expiry and root only when a series is given', () => {
    expect(optionChainPath('equity', 'AAPL', null)).toBe('/api/options?market=equity&symbol=AAPL');
    expect(optionChainPath('equity', 'AAPL', { root: 'AAPL', expiry: '2026-11-13' })).toBe(
      '/api/options?market=equity&symbol=AAPL&expiry=2026-11-13&root=AAPL',
    );
  });

  it('encodes the root of a series', () => {
    expect(optionChainPath('equity', 'AAPL', { root: 'SP:SPX', expiry: '2026-12-18' })).toContain('&root=SP%3ASPX');
  });
});

describe('seriesKey', () => {
  it('joins expiry and root with a bar', () => {
    expect(seriesKey({ root: 'AAPL', expiry: '2026-11-13' })).toBe('2026-11-13|AAPL');
  });
});

describe('parseOptionChain', () => {
  it('accepts a full good body', () => {
    const view = parseOptionChain(goodBody());
    expect(view).not.toBeNull();
    expect(view!.market).toBe('equity');
    expect(view!.symbol).toBe('AAPL');
    expect(view!.status).toBe('ok');
    expect(view!.underlying).toBe('NASDAQ:AAPL');
    expect(view!.series).toEqual([
      { root: 'AAPL', expiry: '2026-11-13', contracts: 40 },
      { root: 'AAPL', expiry: '2026-11-20', contracts: 36 },
    ]);
    expect(view!.selected).toEqual({ root: 'AAPL', expiry: '2026-11-13' });
    expect(view!.capturedMs).toBe(1_700_000_000_000);
    expect(view!.stale).toBe(false);
    expect(view!.source).toBe('tradingview');
    expect(view!.strikes[0].call).toEqual({
      symbol: 'OPRA:AAPL261113C100',
      bid: 1.5,
      bidSize: null,
      ask: 1.6,
      askSize: null,
      last: null,
      theo: 1.55,
      iv: 0.25,
      volume: null,
      openInterest: null,
      delta: 0.5,
      gamma: 0.02,
      theta: -0.1,
      vega: 0.2,
      rho: 0.03,
    });
    // A source that states no underlying price, unit or delay leaves them absent.
    expect(view!.underlyingPrice).toBeNull();
    expect(view!.premiumUnit).toBeNull();
    expect(view!.delayS).toBeNull();
  });

  it('reads the sizes, the last trade, volume, open interest and the source facts a publisher states', () => {
    const body = goodBody();
    body.source = 'cboe';
    body.underlyingPrice = 355.2;
    body.premiumUnit = 'USD';
    body.delayS = 900;
    body.strikes = [{
      strike: 100,
      call: side('AAPL261113C00100000', { bidSize: 12, askSize: 30, last: 1.52, volume: 250, openInterest: 1800 }),
      put: null,
    }];
    const view = parseOptionChain(body)!;
    expect(view.source).toBe('cboe');
    expect(view.underlyingPrice).toBe(355.2);
    expect(view.premiumUnit).toBe('USD');
    expect(view.delayS).toBe(900);
    expect(view.strikes[0].call).toMatchObject({ bidSize: 12, askSize: 30, last: 1.52, volume: 250, openInterest: 1800 });
  });

  it('refuses an underlying price that is not positive and a negative delay', () => {
    const body = goodBody();
    body.underlyingPrice = 0;
    body.delayS = -5;
    body.premiumUnit = '';
    const view = parseOptionChain(body)!;
    expect(view.underlyingPrice).toBeNull();
    expect(view.delayS).toBeNull();
    expect(view.premiumUnit).toBeNull();
  });

  it('drops a series row with a malformed expiry, empty root, bad count or a non-record', () => {
    const body = goodBody();
    body.series = [
      { root: 'AAPL', expiry: '2026/11/13', contracts: 1 },
      { root: '', expiry: '2026-11-13', contracts: 1 },
      { root: 'AAPL', expiry: '2026-11-13', contracts: -1 },
      { root: 'AAPL', expiry: '2026-11-13', contracts: '3' },
      { root: 'AAPL', expiry: '2026-11-13' },
      'AAPL',
      { root: 'AAPL', expiry: '2026-11-27', contracts: 0 },
    ];
    const view = parseOptionChain(body);
    expect(view!.series).toEqual([{ root: 'AAPL', expiry: '2026-11-27', contracts: 0 }]);
  });

  it('drops malformed strike rows and keeps a strike that lists one side only', () => {
    const body = goodBody();
    body.strikes = [
      { strike: '100', call: side('C100'), put: null },
      { call: side('C-none'), put: null },
      null,
      { strike: 95, call: null, put: null },
      { strike: 105, call: side('C105'), put: null },
      { strike: 115, call: null, put: side('P115') },
    ];
    const view = parseOptionChain(body);
    expect(view!.strikes.map((row) => row.strike)).toEqual([105, 115]);
    expect(view!.strikes[0].put).toBeNull();
    expect(view!.strikes[0].call?.symbol).toBe('C105');
    expect(view!.strikes[1].call).toBeNull();
    expect(view!.strikes[1].put?.symbol).toBe('P115');
  });

  it('drops a side that has no symbol text while keeping the strike', () => {
    const body = goodBody();
    body.strikes = [{ strike: 100, call: { bid: 1 }, put: side('P100') }];
    const view = parseOptionChain(body);
    expect(view!.strikes).toHaveLength(1);
    expect(view!.strikes[0].call).toBeNull();
    expect(view!.strikes[0].put?.symbol).toBe('P100');
  });

  it('turns non-numbers into null, including NaN-like strings and missing fields', () => {
    const body = goodBody();
    body.strikes = [
      {
        strike: 100,
        call: { symbol: 'C100', bid: '1.5', ask: null, theo: Number.NaN, iv: undefined, delta: true, gamma: [], theta: {}, vega: 0, rho: -0.5 },
        put: null,
      },
    ];
    const call = parseOptionChain(body)!.strikes[0].call!;
    expect(call.bid).toBeNull();
    expect(call.ask).toBeNull();
    expect(call.theo).toBeNull();
    expect(call.iv).toBeNull();
    expect(call.delta).toBeNull();
    expect(call.gamma).toBeNull();
    expect(call.theta).toBeNull();
    // Zero and negative numbers are numbers, not gaps.
    expect(call.vega).toBe(0);
    expect(call.rho).toBe(-0.5);
  });

  it('sorts strikes ascending whatever the order the body lists them in', () => {
    const body = goodBody();
    body.strikes = [strikeRow(110), strikeRow(90), strikeRow(100.5)];
    const view = parseOptionChain(body);
    expect(view!.strikes.map((row) => row.strike)).toEqual([90, 100.5, 110]);
  });

  it.each(['ok', 'none', 'unsupported', 'unreachable'])('accepts status %s', (status) => {
    expect(parseOptionChain({ ...goodBody(), status })?.status).toBe(status);
  });

  it('refuses a body with an unknown status', () => {
    expect(parseOptionChain({ ...goodBody(), status: 'stale' })).toBeNull();
    expect(parseOptionChain({ ...goodBody(), status: 1 })).toBeNull();
    const { status: _omit, ...withoutStatus } = goodBody();
    expect(parseOptionChain(withoutStatus)).toBeNull();
  });

  it('refuses a body without market or symbol', () => {
    const { market: _m, ...noMarket } = goodBody();
    const { symbol: _s, ...noSymbol } = goodBody();
    expect(parseOptionChain(noMarket)).toBeNull();
    expect(parseOptionChain(noSymbol)).toBeNull();
    expect(parseOptionChain({ ...goodBody(), market: 7 })).toBeNull();
  });

  it.each([null, undefined, 'ok', 42, true, [], [goodBody()]])('refuses a non-object body: %j', (value) => {
    expect(parseOptionChain(value)).toBeNull();
  });

  it('reads stale only when it is exactly true, and a malformed selected series as null', () => {
    expect(parseOptionChain({ ...goodBody(), stale: 'true' })!.stale).toBe(false);
    expect(parseOptionChain({ ...goodBody(), stale: true })!.stale).toBe(true);
    expect(parseOptionChain({ ...goodBody(), selected: { root: 'AAPL', expiry: 'soon' } })!.selected).toBeNull();
    expect(parseOptionChain({ ...goodBody(), selected: null })!.selected).toBeNull();
  });

  it('gives null underlying and an empty source when the body does not state them', () => {
    const view = parseOptionChain({ ...goodBody(), underlying: 3, source: null });
    expect(view!.underlying).toBeNull();
    expect(view!.source).toBe('');
  });
});

function strikeRow(value: number): Record<string, unknown> {
  return { strike: value, call: side(`C${value}`), put: null };
}

describe('daysToExpiry', () => {
  it('counts whole calendar days from today (UTC) to the expiry day', () => {
    expect(daysToExpiry('2026-11-12', NOW)).toBe(0);
    expect(daysToExpiry('2026-11-13', NOW)).toBe(1);
    expect(daysToExpiry('2026-11-11', NOW)).toBe(-1);
    expect(daysToExpiry('2026-11-19', NOW)).toBe(7);
  });

  it('is not moved by the time of day', () => {
    expect(daysToExpiry('2026-11-13', Date.UTC(2026, 10, 12, 0, 0, 0))).toBe(1);
    expect(daysToExpiry('2026-11-13', Date.UTC(2026, 10, 12, 23, 59, 59))).toBe(1);
  });

  it('returns null for a value that is not a date', () => {
    expect(daysToExpiry('tomorrow', NOW)).toBeNull();
    expect(daysToExpiry('2026-02-30', NOW)).toBeNull();
  });

  it('returns null for a non-finite clock', () => {
    expect(daysToExpiry('2026-11-13', Number.NaN)).toBeNull();
  });
});

describe('expiryMs', () => {
  it('returns UTC midnight of a valid day', () => {
    expect(expiryMs('2026-11-13')).toBe(Date.UTC(2026, 10, 13));
    expect(expiryMs('2028-02-29')).toBe(Date.UTC(2028, 1, 29));
  });

  it('refuses 2026-02-30 (a day the calendar does not have)', () => {
    expect(expiryMs('2026-02-30')).toBeNull();
    expect(expiryMs('2026-02-29')).toBeNull();
  });

  it('refuses text that is not YYYY-MM-DD', () => {
    expect(expiryMs('2026-11-1')).toBeNull();
    expect(expiryMs('13/11/2026')).toBeNull();
    expect(expiryMs('')).toBeNull();
  });
});

describe('decimalsOf', () => {
  it('counts the decimals a number needs, at most six', () => {
    expect(decimalsOf(307.5)).toBe(1);
    expect(decimalsOf(1.14)).toBe(2);
    expect(decimalsOf(7000)).toBe(0);
    expect(decimalsOf(0.000001)).toBe(6);
    expect(decimalsOf(0.0000001)).toBe(0);
  });

  it('returns 0 for a non-finite value', () => {
    expect(decimalsOf(Number.NaN)).toBe(0);
    expect(decimalsOf(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('strikeDecimals and premiumDecimals', () => {
  it('takes the most decimals any strike needs', () => {
    expect(strikeDecimals([strike(100), strike(105), strike(110)])).toBe(0);
    expect(strikeDecimals([strike(100), strike(102.5), strike(110)])).toBe(1);
    expect(strikeDecimals([strike(1.1), strike(1.14)])).toBe(2);
    expect(strikeDecimals([])).toBe(0);
  });

  it('writes premiums with two decimals for whole strikes', () => {
    expect(premiumDecimals([strike(100), strike(110)])).toBe(2);
    expect(premiumDecimals([])).toBe(2);
  });

  it('writes premiums with as many decimals as the finest quote states, between two and six', () => {
    expect(premiumDecimals([quoted(100, { bid: 1.5, ask: 1.55 })])).toBe(2);
    expect(premiumDecimals([quoted(100, { bid: 0.125, ask: 0.13 })])).toBe(3);
    expect(premiumDecimals([quoted(1.1, { bid: 0.00004, ask: 0.00005 })])).toBe(5);
    expect(premiumDecimals([quoted(1.1, { bid: 0.0000001, ask: 0.1234567 })])).toBe(6);
    // The strikes do not decide it: a fine strike with coarse quotes stays at two.
    expect(premiumDecimals([quoted(1.1234, { bid: 0.5, ask: 0.6 })])).toBe(2);
  });

  it('measures a series without a single quote on its theoretical prices, at most four', () => {
    expect(premiumDecimals([quoted(1.14, { bid: null, ask: null, theo: 0.03 })])).toBe(2);
    expect(premiumDecimals([quoted(1.14, { bid: null, ask: null, theo: 0.0312 })])).toBe(4);
    expect(premiumDecimals([quoted(1.14, { bid: null, ask: null, theo: 0.031234 })])).toBe(4);
    // One stated quote is enough for the quotes to decide.
    expect(premiumDecimals([quoted(1.14, { bid: 0.5, ask: null, theo: 0.031234 })])).toBe(2);
  });
});

describe('spotDecimals', () => {
  it('writes the chart price with what it needs, between two and six decimals', () => {
    expect(spotDecimals(7602)).toBe(2);
    expect(spotDecimals(355.53)).toBe(2);
    expect(spotDecimals(1.15872)).toBe(5);
    expect(spotDecimals(0.00001234)).toBe(6);
  });
});

describe('midDeltaStrike', () => {
  const withDelta = (value: number, call: number | null, put: number | null): OptionStrike => ({
    strike: value,
    call: call === null ? null : contract({ delta: call }),
    put: put === null ? null : contract({ delta: put }),
  });

  it('is the strike whose call delta is nearest to one half', () => {
    expect(midDeltaStrike([withDelta(90, 0.9, -0.1), withDelta(100, 0.55, -0.45), withDelta(110, 0.2, -0.8)])).toBe(100);
  });

  it('reads the put deltas only when no call states one', () => {
    expect(midDeltaStrike([withDelta(90, null, -0.1), withDelta(100, null, -0.48), withDelta(110, null, -0.8)])).toBe(100);
    // A single call delta decides, even when a put would sit closer to minus one half.
    expect(midDeltaStrike([withDelta(90, 0.9, null), withDelta(100, null, -0.5)])).toBe(90);
  });

  it('is null when no contract states a delta', () => {
    expect(midDeltaStrike([strike(90), strike(100)])).toBeNull();
    expect(midDeltaStrike([])).toBeNull();
  });
});

describe('atmStrike', () => {
  const strikes = [strike(90), strike(100), strike(110)];

  it('picks the nearest listed strike', () => {
    expect(atmStrike(strikes, 104)).toBe(100);
    expect(atmStrike(strikes, 106)).toBe(110);
    expect(atmStrike(strikes, 90)).toBe(90);
    expect(atmStrike(strikes, 500)).toBe(110);
  });

  it('picks the lower strike on a tie', () => {
    expect(atmStrike(strikes, 105)).toBe(100);
    expect(atmStrike(strikes, 95)).toBe(90);
  });

  it('picks the lower strike on a tie whatever order the strikes come in', () => {
    expect(atmStrike([strike(110), strike(100), strike(90)], 105)).toBe(100);
    expect(atmStrike([strike(100), strike(90), strike(110)], 95)).toBe(90);
  });

  it('returns null without a spot, with a spot of zero or below, or with a non-finite spot', () => {
    expect(atmStrike(strikes, null)).toBeNull();
    expect(atmStrike(strikes, 0)).toBeNull();
    expect(atmStrike(strikes, -3)).toBeNull();
    expect(atmStrike(strikes, Number.NaN)).toBeNull();
    expect(atmStrike(strikes, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null when there are no strikes', () => {
    expect(atmStrike([], 100)).toBeNull();
  });
});

describe('chartPrice', () => {
  function snapshot(trades: Array<{ price: number }>, bbo: { bidPx: number; askPx: number } | null): Pick<BookSnapshot, 'bbo' | 'trades'> {
    return {
      bbo: bbo === null ? null : { tsNs: 0n, bidSz: 1, askSz: 1, ...bbo },
      trades: trades.map((t) => ({ tsNs: 0n, size: 1, side: 0, ...t })),
    } as unknown as Pick<BookSnapshot, 'bbo' | 'trades'>;
  }

  it('prefers the newest trade (trades are newest-first)', () => {
    expect(chartPrice(snapshot([{ price: 101 }, { price: 100 }], { bidPx: 99, askPx: 102 }))).toBe(101);
  });

  it('falls back to the middle of the best bid and ask when nothing has printed', () => {
    expect(chartPrice(snapshot([], { bidPx: 99, askPx: 101 }))).toBe(100);
  });

  it('skips a newest trade whose price is not a positive number', () => {
    expect(chartPrice(snapshot([{ price: 0 }], { bidPx: 99, askPx: 101 }))).toBe(100);
    expect(chartPrice(snapshot([{ price: Number.NaN }], { bidPx: 99, askPx: 101 }))).toBe(100);
  });

  it('returns null when the stream has stated neither a trade nor a quote', () => {
    expect(chartPrice(snapshot([], null))).toBeNull();
  });

  it('ignores a quote with a zero side', () => {
    expect(chartPrice(snapshot([], { bidPx: 0, askPx: 101 }))).toBeNull();
  });
});

describe('optionChainErrorKey', () => {
  it('maps a network failure and any non-chain error to the engine message', () => {
    expect(optionChainErrorKey(new OptionChainRequestError('network', 0))).toEqual({ key: 'optionChain.errorEngine' });
    expect(optionChainErrorKey(new Error('boom'))).toEqual({ key: 'optionChain.errorEngine' });
    expect(optionChainErrorKey('nope')).toEqual({ key: 'optionChain.errorEngine' });
  });

  it('maps an unreadable answer to the response message', () => {
    expect(optionChainErrorKey(new OptionChainRequestError('invalid', 200))).toEqual({ key: 'optionChain.errorResponse' });
  });

  it('maps an HTTP error to the HTTP message with its status', () => {
    expect(optionChainErrorKey(new OptionChainRequestError('http', 500))).toEqual({ key: 'optionChain.errorHttp', status: 500 });
  });
});

describe('fetchOptionChain', () => {
  it('reads one chain and returns the parsed view', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(200, JSON.stringify(goodBody())));
    vi.stubGlobal('fetch', fetch);
    const view = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal);
    expect(view.symbol).toBe('AAPL');
    expect(view.strikes).toHaveLength(2);
    expect(String(fetch.mock.calls[0][0])).toContain('/api/options?market=equity&symbol=AAPL');
  });

  it('names the series in the request when one is given', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(200, JSON.stringify(goodBody())));
    vi.stubGlobal('fetch', fetch);
    await fetchOptionChain('equity', 'AAPL', { root: 'AAPL', expiry: '2026-11-20' }, new AbortController().signal);
    expect(String(fetch.mock.calls[0][0])).toContain('&expiry=2026-11-20&root=AAPL');
  });

  it('rejects an HTTP 500 with a JSON body as http', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(500, JSON.stringify({ detail: 'x' }))));
    const error = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OptionChainRequestError);
    expect((error as OptionChainRequestError).kind).toBe('http');
    expect((error as OptionChainRequestError).status).toBe(500);
  });

  it('rejects an HTTP 502 with an HTML body as network (no engine answered)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(502, '<html>Bad Gateway</html>')));
    const error = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OptionChainRequestError);
    expect((error as OptionChainRequestError).kind).toBe('network');
    expect((error as OptionChainRequestError).status).toBe(502);
  });

  it('rejects a 200 whose body is not a chain as invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, JSON.stringify({ status: 'maybe', market: 'equity', symbol: 'AAPL' }))));
    const error = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal).catch((e: unknown) => e);
    expect((error as OptionChainRequestError).kind).toBe('invalid');
    expect((error as OptionChainRequestError).status).toBe(200);
  });

  it('rejects a 200 whose body is not JSON as invalid', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, '<html>ok</html>')));
    const error = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal).catch((e: unknown) => e);
    expect((error as OptionChainRequestError).kind).toBe('invalid');
  });

  it('rejects a refused connection as network with status 0', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const error = await fetchOptionChain('equity', 'AAPL', null, new AbortController().signal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OptionChainRequestError);
    expect((error as OptionChainRequestError).kind).toBe('network');
    expect((error as OptionChainRequestError).status).toBe(0);
  });

  it('rethrows the abort when the caller aborted, instead of a network error', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => {
      ctrl.abort();
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }));
    const error = await fetchOptionChain('equity', 'AAPL', null, ctrl.signal).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(OptionChainRequestError);
    expect((error as Error).name).toBe('AbortError');
  });
});

describe('moneyBand', () => {
  const strikes = [strike(90), strike(100), strike(110)];

  it('is the same for two prices that mark and tint the table the same way', () => {
    expect(moneyBand(strikes, 101)).toBe(moneyBand(strikes, 104));
    expect(moneyBand(strikes, 101)).toBe('2|100|1');
  });

  it('changes when the price crosses a strike or the nearest strike changes', () => {
    expect(moneyBand(strikes, 99)).not.toBe(moneyBand(strikes, 101));
    expect(moneyBand(strikes, 104)).not.toBe(moneyBand(strikes, 106));
    // Exactly on a strike: that strike is neither below nor above.
    expect(moneyBand(strikes, 100)).toBe('1|100|1');
  });

  it('is null without a price or without strikes', () => {
    expect(moneyBand(strikes, null)).toBeNull();
    expect(moneyBand([], 100)).toBeNull();
    expect(moneyBand(strikes, 0)).toBeNull();
  });
});

describe('hasActivity', () => {
  it('is true once any contract states a size, a last trade, a volume or an open interest', () => {
    expect(hasActivity([quoted(100, { bid: 1, ask: 2 })])).toBe(false);
    expect(hasActivity([quoted(100, { bidSize: 5 })])).toBe(true);
    expect(hasActivity([quoted(100, { askSize: 0 })])).toBe(true);
    expect(hasActivity([quoted(100, { last: 1.5 })])).toBe(true);
    expect(hasActivity([quoted(100, { volume: 0 })])).toBe(true);
    expect(hasActivity([{ strike: 100, call: null, put: contract({ openInterest: 12 }) }])).toBe(true);
    expect(hasActivity([])).toBe(false);
  });
});

describe('referencePrice', () => {
  it('is the chart price when the chart has one near the price the source states', () => {
    expect(referencePrice(355.6, 355.2)).toEqual({ price: 355.6, from: 'chart' });
    expect(referencePrice(355.6, null)).toEqual({ price: 355.6, from: 'chart' });
  });

  it('is the source price when the chart has none', () => {
    expect(referencePrice(null, 7592.6)).toEqual({ price: 7592.6, from: 'source' });
    expect(referencePrice(0, 7592.6)).toEqual({ price: 7592.6, from: 'source' });
  });

  it('is the source price when the chart is plainly not the underlying', () => {
    // ETH charted against BTC: 0.028 is not the price ETH options are struck around.
    expect(referencePrice(0.028, 2016)).toEqual({ price: 2016, from: 'source' });
    // Within a fifth: the chart is the underlying, a little ahead of a delayed source.
    expect(referencePrice(2300, 2016)).toEqual({ price: 2300, from: 'chart' });
    expect(referencePrice(2500, 2016)).toEqual({ price: 2016, from: 'source' });
  });

  it('is null when neither states a price', () => {
    expect(referencePrice(null, null)).toBeNull();
    expect(referencePrice(Number.NaN, 0)).toBeNull();
  });
});

describe('visibleDecimals', () => {
  it('keeps the series decimals for a price they can show', () => {
    expect(visibleDecimals(1.5, 2)).toBe(2);
    expect(visibleDecimals(0.01, 2)).toBe(2);
    expect(visibleDecimals(0.005, 2)).toBe(2);
    expect(visibleDecimals(0, 2)).toBe(2);
  });

  it('adds decimals to a price that would otherwise be written as zero', () => {
    // A coin-denominated model price in a series quoted to four decimals.
    expect(visibleDecimals(0.00001074, 4)).toBe(7);
    expect((0.00001074).toFixed(visibleDecimals(0.00001074, 4))).toBe('0.0000107');
    expect(visibleDecimals(0.004, 2)).toBe(5);
    expect(visibleDecimals(-0.00002, 4)).toBe(7);
  });

  it('never asks for more than twelve decimals', () => {
    expect(visibleDecimals(1e-30, 2)).toBe(12);
  });
});

