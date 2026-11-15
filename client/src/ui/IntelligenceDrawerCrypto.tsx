/**
 * The four crypto tabs of the Research drawer (PERP, OPTIONS, MARKET, SENTIMENT).
 * Each card asks the server for its section when it mounts, so only the visible
 * tab fetches. OPTIONS reuses the GEX levels of the US FLOW tab.
 */

import type { ReactNode } from 'react';

import { formatFixed, formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import { useResearchSection } from '../app/useResearchSection';
import type { DerivativesData, MarketData, GexData, SentimentData } from '../net/researchApi';
import {
  countOrDash,
  DASH,
  dayOrDash,
  fixedOrDash,
  instantText,
  percentOfFraction,
  pctOrDash,
  priceText,
  quantityOrDash,
  sentimentLabelText,
  signedPctOrDash,
  tvlSourceText,
  usdCompact,
} from './IntelligenceDrawerFormat';
import { GexBody, type ResearchCardProps } from './IntelligenceDrawerPanes';
import { IntelSection, KeyValue, reasonText } from './IntelligenceDrawerSection';

function Pane({ id, children }: { id: 'PERP' | 'OPTIONS' | 'MARKET' | 'SENTIMENT'; children: ReactNode }): JSX.Element {
  return (
    <div
      className="intel-tab-pane"
      data-testid={`pane-${id.toLowerCase()}`}
      role="tabpanel"
      id={`intel-panel-${id}`}
      aria-labelledby={`intel-tab-${id}`}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

// ---- PERP ----

function DerivativesBody({ d }: { d: DerivativesData }): JSX.Element {
  const t = useT();
  const hours = d.fundingIntervalHours;
  const rate = percentOfFraction(d.fundingRate, 4);
  return (
    <>
      <p className="research-line">{t('research.perp.pair', { pair: d.pair ?? DASH })}</p>
      <div className="research-kv">
        <KeyValue label={t('research.perp.mark')} value={priceText(d.markPrice)} />
        <KeyValue label={t('research.perp.index')} value={priceText(d.indexPrice)} />
        <KeyValue
          label={t('research.perp.funding')}
          value={rate}
          sub={hours === null ? undefined : t('research.perp.perInterval', { hours: formatFixed(hours, 0) })}
        />
        <KeyValue label={t('research.perp.annual')} value={pctOrDash(d.fundingRateAnnualPct, 2)} />
        <KeyValue label={t('research.perp.nextFunding')} value={instantText(d.nextFundingTime)} />
        <KeyValue label={t('research.perp.oiCoins')} value={quantityOrDash(d.openInterest)} />
        <KeyValue label={t('research.perp.oiUsd')} value={usdCompact(d.openInterestUsd)} />
        <KeyValue
          label={t('research.perp.accounts')}
          value={fixedOrDash(d.longShortAccountRatio, 2)}
          sub={t('research.perp.longShort', { long: pctOrDash(d.longAccountPct, 2), short: pctOrDash(d.shortAccountPct, 2) })}
        />
        <KeyValue label={t('research.perp.taker')} value={fixedOrDash(d.takerBuySellRatio, 2)} />
      </div>
    </>
  );
}

export function PerpCard({ symbol }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('crypto', 'derivatives', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<DerivativesData>
      section="derivatives"
      source="Binance Futures"
      title={t('research.perp.title')}
      desc={t('research.perp.desc')}
      testId="research-derivatives"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
    >
      {(d) => <DerivativesBody d={d} />}
    </IntelSection>
  );
}

// ---- OPTIONS ----

export function CryptoOptionsCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('crypto', 'options', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<GexData>
      section="options"
      source="Deribit"
      title={t('research.options.title')}
      desc={t('research.options.desc')}
      testId="research-options"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => <GexBody d={d} />}
    </IntelSection>
  );
}

// ---- MARKET ----

function MarketBody({ d }: { d: MarketData }): JSX.Element {
  const t = useT();
  return (
    <>
      <p className="research-line">
        {t('research.market.name', { name: d.name ?? DASH, rank: countOrDash(d.rank) })}
      </p>
      <div className="research-kv">
        <KeyValue label={t('research.market.price')} value={priceText(d.price)} />
        <KeyValue label={t('research.market.change24')} value={signedPctOrDash(d.change24hPct, 2)} />
        <KeyValue label={t('research.market.change7')} value={signedPctOrDash(d.change7dPct, 2)} />
        <KeyValue label={t('research.market.change30')} value={signedPctOrDash(d.change30dPct, 2)} />
        <KeyValue label={t('research.market.cap')} value={usdCompact(d.marketCap)} />
        <KeyValue label={t('research.market.volume')} value={usdCompact(d.volume24h)} />
        <KeyValue label={t('research.market.circulating')} value={quantityOrDash(d.circulatingSupply)} />
        <KeyValue label={t('research.market.total')} value={quantityOrDash(d.totalSupply)} />
        <KeyValue label={t('research.market.max')} value={d.maxSupply === null ? t('research.market.noMax') : quantityOrDash(d.maxSupply)} />
        <KeyValue
          label={t('research.market.ath')}
          value={priceText(d.ath)}
          sub={t('research.market.athDate', { date: dayOrDash(d.athDate) })}
        />
        <KeyValue label={t('research.market.athDistance')} value={signedPctOrDash(d.athChangePct, 2)} />
        {/* The proper noun keeps its own case: the label is uppercase in Turkish. */}
        <KeyValue
          label={<>TVL (<span lang="en">DefiLlama</span>)</>}
          value={d.tvl === null ? DASH : usdCompact(d.tvl)}
          sub={d.tvl === null ? undefined : tvlSourceText(t, d.tvlSource)}
        />
      </div>
      {d.tvl === null && d.tvlReason !== null && (
        <p className="intel-section__note" data-testid="research-tvl-reason">{reasonText(t, d.tvlReason, 'market')}</p>
      )}
    </>
  );
}

export function MarketCard({ symbol }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('crypto', 'market', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<MarketData>
      section="market"
      source="CoinGecko and DefiLlama"
      title={t('research.market.title')}
      desc={t('research.market.desc')}
      testId="research-market"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
    >
      {(d) => <MarketBody d={d} />}
    </IntelSection>
  );
}

// ---- SENTIMENT ----

/** The 30-day path as a plain SVG line, oldest day on the left, scaled 0 to 100. */
function SentimentPath({ history }: { history: SentimentData['history'] }): JSX.Element | null {
  const t = useT();
  const points = history
    .filter((p): p is { date: string; value: number } => p.date !== null && p.value !== null)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (points.length < 2) return null;
  const width = 300;
  const height = 80;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width;
    const y = height - (Math.max(0, Math.min(100, p.value)) / 100) * height;
    // SVG coordinates are plain numbers with a dot: never the locale's decimal comma.
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      className="research-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={t('research.sent.pathLabel', { days: formatNumber(points.length) })}
      data-testid="research-sentiment-path"
    >
      <line className="research-spark__base" x1={0} x2={width} y1={height} y2={height} />
      <polyline className="research-spark__line" points={coords.join(' ')} />
    </svg>
  );
}

function SentimentBody({ d }: { d: SentimentData }): JSX.Element {
  const t = useT();
  return (
    <>
      <div className="research-kv">
        <KeyValue label={t('research.sent.value')} value={fixedOrDash(d.value, 0)} sub={sentimentLabelText(t, d.label)} />
        <KeyValue label={t('research.sent.avg7')} value={fixedOrDash(d.avg7d, 1)} />
        <KeyValue label={t('research.sent.avg30')} value={fixedOrDash(d.avg30d, 1)} />
      </div>
      <SentimentPath history={d.history} />
      <p className="intel-section__note">{t('research.sent.note')}</p>
    </>
  );
}

/** The index is market-wide; the symbol only keys the request. */
export function SentimentCard({ symbol }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('crypto', 'sentiment', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<SentimentData>
      section="sentiment"
      source="alternative.me"
      title={t('research.sent.title')}
      desc={t('research.sent.desc')}
      testId="research-sentiment"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
    >
      {(d) => <SentimentBody d={d} />}
    </IntelSection>
  );
}

// ---- tab panes ----

export function IntelPerpPane({ symbol }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="PERP">
      <PerpCard symbol={symbol} />
    </Pane>
  );
}

export function IntelOptionsPane({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="OPTIONS">
      <CryptoOptionsCard symbol={symbol} onOpenSettings={onOpenSettings} />
    </Pane>
  );
}

export function IntelMarketPane({ symbol }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="MARKET">
      <MarketCard symbol={symbol} />
    </Pane>
  );
}

export function IntelSentimentPane({ symbol }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="SENTIMENT">
      <SentimentCard symbol={symbol} />
    </Pane>
  );
}
