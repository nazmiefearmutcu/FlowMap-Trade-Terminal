/**
 * Strings of the top bar's real order book link: shown on an instrument that is drawn as a
 * synthetic profile when another venue this build streams has a real book on the same
 * underlying. Merged into the lookup by tables.ts, like every feature table.
 */

export const realBookEn: Record<string, string> = {
  'topbar.realBook': 'Book: {market} {symbol}',
  'topbar.realBookTitle':
    'No public source shows the resting orders of this instrument. {market}:{symbol} is that venue\'s own {kind} on the same underlying, and its order book is real. Click to open it.',
  'topbar.realBook.spot': 'spot market',
  'topbar.realBook.perpetual': 'perpetual contract',
};

export const realBookTr: Record<string, string> = {
  'topbar.realBook': 'Defter: {market} {symbol}',
  'topbar.realBookTitle':
    'Bu enstrümanın bekleyen emirlerini gösteren açık bir kaynak yok. {market}:{symbol}, o borsanın aynı dayanak üzerindeki kendi {kind} enstrümanıdır ve emir defteri gerçektir. Açmak için tıklayın.',
  'topbar.realBook.spot': 'spot piyasa',
  'topbar.realBook.perpetual': 'sürekli vadeli sözleşme',
};
