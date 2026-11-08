import { beforeEach, expect, it } from 'vitest';
import { ACTIVE_SYMBOL_KEY, loadStartupSymbol, saveStartupSymbol } from './startupSymbol';
beforeEach(() => localStorage.clear());
it('restores the explicit active instrument ahead of recents', () => {
  localStorage.setItem('flowmap.recents', JSON.stringify(['binance-spot:RUNEUSDT']));
  saveStartupSymbol(localStorage, 'binance-spot', 'BTCUSDT');
  expect(loadStartupSymbol(localStorage)).toEqual({ market: 'binance-spot', symbol: 'BTCUSDT' });
});
it('uses valid recents on migration and the explicit demo only without a saved instrument', () => {
  localStorage.setItem(ACTIVE_SYMBOL_KEY, '{broken');
  localStorage.setItem('flowmap.recents', JSON.stringify(['binance-spot:RUNEUSDT']));
  expect(loadStartupSymbol(localStorage).symbol).toBe('RUNEUSDT');
  expect(loadStartupSymbol(null)).toEqual({ market: 'sim', symbol: 'SIM-DEMO' });
});
it('a ?symbol= deep link opens that instrument ahead of the saved pick', () => {
  saveStartupSymbol(localStorage, 'binance-spot', 'BTCUSDT');
  expect(loadStartupSymbol(localStorage, '?symbol=binance-spot:ETHUSDT')).toEqual({ market: 'binance-spot', symbol: 'ETHUSDT' });
});
it('ignores a malformed ?symbol= silently and falls back to the saved pick', () => {
  saveStartupSymbol(localStorage, 'binance-spot', 'BTCUSDT');
  expect(loadStartupSymbol(localStorage, '?symbol=nocolon')).toEqual({ market: 'binance-spot', symbol: 'BTCUSDT' });
  expect(loadStartupSymbol(localStorage, '?symbol=:BTCUSDT')).toEqual({ market: 'binance-spot', symbol: 'BTCUSDT' });
  expect(loadStartupSymbol(localStorage, '?symbol=bad%20market:BTC')).toEqual({ market: 'binance-spot', symbol: 'BTCUSDT' });
});
