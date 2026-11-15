/**
 * Strings of Settings → Markets (ui/SettingsDrawerMarkets.tsx) and of the market map's
 * notice when its markets are switched off. Merged into the lookup by tables.ts, like
 * every feature table.
 */

export const marketsEn: Record<string, string> = {
  'drawer.sectionMarkets': 'Markets',
  'settings.markets.hint':
    'A market that is off is left out of the symbol search and the market map, and FlowMap asks for none of its data. A chart already open on it stays open.',
  'settings.markets.search': 'Find a market',
  'settings.markets.loading': 'Reading the list of markets…',
  'settings.markets.count': '{on} of {total} on',
  'settings.markets.browse': 'Browse',
  'settings.markets.browseTitle': 'Open the symbol search on {market}',
  'settings.markets.group.crypto': 'Crypto',
  'settings.markets.group.us': 'US stocks',
  'settings.markets.group.world': 'World stock exchanges',
  'settings.markets.group.futures': 'Futures',
  'settings.markets.group.forex': 'Currencies',
  'settings.markets.group.indices': 'Indices',
  'settings.markets.group.bonds': 'Government bonds',
  'settings.markets.group.sim': 'Simulation',
  'marketMap.allOff': 'Both markets of the map are switched off in Settings → Markets.',
};

export const marketsTr: Record<string, string> = {
  'drawer.sectionMarkets': 'Piyasalar',
  'settings.markets.hint':
    'Kapalı bir piyasa sembol aramasında ve piyasa haritasında görünmez; FlowMap onun hiçbir verisini istemez. O piyasada açık olan grafik açık kalır.',
  'settings.markets.search': 'Piyasa ara',
  'settings.markets.loading': 'Piyasa listesi okunuyor…',
  'settings.markets.count': '{total} piyasadan {on} açık',
  'settings.markets.browse': 'Göz at',
  'settings.markets.browseTitle': 'Sembol aramasını {market} üzerinde aç',
  'settings.markets.group.crypto': 'Kripto',
  'settings.markets.group.us': 'ABD hisseleri',
  'settings.markets.group.world': 'Dünya borsaları',
  'settings.markets.group.futures': 'Vadeli işlemler',
  'settings.markets.group.forex': 'Döviz',
  'settings.markets.group.indices': 'Endeksler',
  'settings.markets.group.bonds': 'Devlet tahvilleri',
  'settings.markets.group.sim': 'Simülasyon',
  'marketMap.allOff': 'Haritanın iki piyasası da Ayarlar → Piyasalar bölümünde kapalı.',
};
