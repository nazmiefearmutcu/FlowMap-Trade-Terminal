/**
 * The four US tabs of the Research drawer (DOCS, GOV, FLOW, GEO). Each card asks
 * the server for its own section when it mounts, so only the visible tab fetches.
 * The GEX levels are shared with the crypto OPTIONS tab (GexBody).
 */

import type { ReactNode } from 'react';

import { formatNumber } from '../i18n/format';
import { useT, type TFn } from '../i18n/useT';
import { useResearchSection } from '../app/useResearchSection';
import type {
  ContractAward,
  GexData,
  HiringData,
  HouseTrade,
  ManagementLanguageData,
  RiskFactorsData,
  ShortVolumeData,
} from '../net/researchApi';
import {
  countOrDash,
  dayOrDash,
  DASH,
  fixedOrDash,
  pctOrDash,
  priceText,
  quantityOrDash,
  signedOrDash,
  signedPctOrDash,
  usdCompact,
} from './IntelligenceDrawerFormat';
import { IntelSection, KeyValue } from './IntelligenceDrawerSection';

/** What every card needs: the symbol and the settings opener. */
export interface ResearchCardProps {
  symbol: string;
  onOpenSettings?: () => void;
}

/** The two SEC cards also send the user's SEC contact; the others never see it. */
export interface SecCardProps extends ResearchCardProps {
  secContact: string;
}

/** The DOCS pane also carries the SEC contact to its two cards. */
export type DocsPaneProps = SecCardProps;

/** An outside link: opens in a new tab with no opener. */
export function ExternalLink({ href, label }: { href: string; label: string }): JSX.Element {
  return (
    <a className="research-link" href={href} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}

/**
 * A list of paragraphs or lines. When the server counted more than it sent, the
 * note says how many are shown; when it counted none, the list says so.
 */
function LineList({ lines, total }: { lines: readonly string[]; total: number | null }): JSX.Element {
  const t = useT();
  const capped = total !== null && total > lines.length;
  if (lines.length === 0 && !capped) return <p className="intel-section__note">{t('research.noLines')}</p>;
  return (
    <div className="research-lines">
      {lines.map((line, idx) => (
        <div key={idx} className="research-line">{line}</div>
      ))}
      {capped && <p className="intel-section__note">{t('research.shownOf', { shown: formatNumber(lines.length), total: formatNumber(total) })}</p>}
    </div>
  );
}

// ---- DOCS ----

export function RiskFactorsCard({ symbol, secContact, onOpenSettings }: SecCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'risk-factors', symbol, { enabled: true, secContact });
  return (
    <IntelSection<RiskFactorsData>
      section="risk-factors"
      source="SEC EDGAR"
      title={t('research.risk.title')}
      desc={t('research.risk.desc')}
      testId="research-risk-factors"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => (
        <>
          <p className="research-line">
            {t('research.risk.compare', {
              form: dayOrDash(d.form),
              date: dayOrDash(d.filedDate),
              prevForm: dayOrDash(d.previousForm),
              prevDate: dayOrDash(d.previousFiledDate),
            })}
          </p>
          <div className="research-kv">
            <KeyValue label={t('research.risk.added')} value={countOrDash(d.addedCount)} />
            <KeyValue label={t('research.risk.removed')} value={countOrDash(d.removedCount)} />
            <KeyValue label={t('research.risk.modified')} value={countOrDash(d.modifiedCount)} />
          </div>
          {d.triggers.length > 0 && (
            <div className="research-block">
              <span className="research-kv__lbl">{t('research.risk.triggers')}</span>
              <div className="intel-triggers">
                {d.triggers.map((trig) => (
                  <span key={trig} className="intel-trigger-badge">{trig}</span>
                ))}
              </div>
            </div>
          )}
          <div className="research-block">
            <span className="research-kv__lbl">{t('research.risk.addedLines')}</span>
            <LineList lines={d.added} total={d.addedCount} />
          </div>
          <div className="research-block">
            <span className="research-kv__lbl">{t('research.risk.removedLines')}</span>
            <LineList lines={d.removed} total={d.removedCount} />
          </div>
          <div className="research-links">
            {d.url && <ExternalLink href={d.url} label={t('research.risk.openFiling')} />}
            {d.previousUrl && <ExternalLink href={d.previousUrl} label={t('research.risk.openPrevious')} />}
          </div>
        </>
      )}
    </IntelSection>
  );
}

export function ManagementLanguageCard({ symbol, secContact, onOpenSettings }: SecCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'language', symbol, { enabled: true, secContact });
  return (
    <IntelSection<ManagementLanguageData>
      section="language"
      source="SEC EDGAR"
      title={t('research.lang.title')}
      desc={t('research.lang.desc')}
      testId="research-language"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => (
        <>
          <p className="research-line">
            {t('research.lang.releases', { date: dayOrDash(d.filedDate), prevDate: dayOrDash(d.previousFiledDate) })}
          </p>
          <div className="research-kv">
            <KeyValue
              label={t('research.lang.hedging')}
              value={fixedOrDash(d.hedgingPer1k, 2)}
              sub={t('research.lang.previous', { value: fixedOrDash(d.previousHedgingPer1k, 2), change: signedOrDash(d.hedgingChange, 2) })}
            />
            <KeyValue
              label={t('research.lang.uncertainty')}
              value={fixedOrDash(d.uncertaintyPer1k, 2)}
              sub={t('research.lang.previous', { value: fixedOrDash(d.previousUncertaintyPer1k, 2), change: signedOrDash(d.uncertaintyChange, 2) })}
            />
            <KeyValue label={t('research.lang.words')} value={countOrDash(d.words)} />
          </div>
          {d.topTerms.length > 0 && (
            <div className="research-block">
              <span className="research-kv__lbl">{t('research.lang.topTerms')}</span>
              <div className="intel-triggers">
                {d.topTerms.map((term, idx) => (
                  <span key={`${term.term ?? ''}-${idx}`} className="intel-trigger-badge">
                    {term.term ?? DASH} · {countOrDash(term.count)}
                  </span>
                ))}
              </div>
            </div>
          )}
          {d.url && (
            <div className="research-links">
              <ExternalLink href={d.url} label={t('research.lang.openRelease')} />
            </div>
          )}
        </>
      )}
    </IntelSection>
  );
}

// ---- GOV ----

function AwardRow({ award }: { award: ContractAward }): JSX.Element {
  const t = useT();
  const agency = [award.agency, award.subAgency].filter((s): s is string => Boolean(s)).join(' · ');
  return (
    <article className="intel-card intel-card--contract">
      <div className="intel-card__top">
        <span className="intel-card__amount">{usdCompact(award.amount)}</span>
        <span className="intel-card__date">{dayOrDash(award.startDate)}</span>
      </div>
      <div className="intel-card__heading">{award.recipient ?? DASH}</div>
      {agency !== '' && <div className="intel-card__recipient">{agency}</div>}
      {award.description && <div className="intel-card__desc">{award.description}</div>}
      {award.url && <ExternalLink href={award.url} label={t('research.gov.openAward')} />}
    </article>
  );
}

export function ContractsCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'contracts', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection
      section="contracts"
      source="USAspending.gov"
      title={t('research.gov.title')}
      desc={t('research.gov.desc')}
      testId="research-contracts"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => (
        <>
          <p className="research-line">
            {t('research.gov.total', {
              total: usdCompact(d.listedTotal),
              matched: countOrDash(d.matchedCount),
              days: countOrDash(d.windowDays),
            })}
          </p>
          {d.awards.map((award, idx) => (
            <AwardRow key={award.awardId ?? idx} award={award} />
          ))}
        </>
      )}
    </IntelSection>
  );
}

/** The trade type in the user's language; a type the drawer does not know is shown with its label. */
function tradeType(t: TFn, type: string | null): string {
  if (type === null) return DASH;
  if (type === 'Purchase') return t('intel.trade.purchase');
  if (type.startsWith('Sale')) return t('intel.trade.sale');
  return t('research.house.typeOther', { type });
}

function TradeRow({ trade }: { trade: HouseTrade }): JSX.Element {
  const t = useT();
  const where = trade.state !== null && trade.district !== null ? `${trade.state}-${trade.district}` : (trade.state ?? DASH);
  return (
    <article className="intel-card intel-card--capitol">
      <div className="intel-card__top">
        <span className="intel-card__side">{tradeType(t, trade.type)}</span>
        <span className="intel-card__date">{dayOrDash(trade.transactionDate)}</span>
      </div>
      <div className="intel-card__politician">
        <strong>{trade.member ?? DASH}</strong> {where}
      </div>
      {trade.committees.length > 0 && (
        <div className="intel-card__committee">{t('intel.committee', { committee: trade.committees.join(', ') })}</div>
      )}
      <div className="intel-card__amount-range">{t('intel.amount', { amount: trade.amount ?? DASH })}</div>
      {trade.reportUrl && <ExternalLink href={trade.reportUrl} label={t('research.house.openReport')} />}
    </article>
  );
}

export function HouseTradesCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'house-trades', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection
      section="house-trades"
      source="House Clerk"
      title={t('research.house.title')}
      desc={t('research.house.desc')}
      testId="research-house-trades"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => {
        const { parsed, total, unreadable } = d.coverage;
        const stillReading = parsed !== null && total !== null && parsed < total;
        return (
          <>
            <p className="intel-section__note" data-testid="research-house-coverage">
              {t('research.house.coverage', {
                parsed: countOrDash(parsed),
                total: countOrDash(total),
                unreadable: countOrDash(unreadable),
              })}
              {stillReading ? ` ${t('research.house.stillReading')}` : ''}
            </p>
            {!d.ownerKnown && <p className="intel-section__note">{t('research.house.owner')}</p>}
            {d.trades.length === 0 ? (
              <p className="intel-empty">{t('research.house.none', { symbol })}</p>
            ) : (
              d.trades.map((trade, idx) => <TradeRow key={`${trade.reportUrl ?? ''}-${idx}`} trade={trade} />)
            )}
          </>
        );
      }}
    </IntelSection>
  );
}

// ---- FLOW ----

/**
 * The GEX levels, shared by the US GEX card and the crypto OPTIONS card. The model
 * reports dollar gamma per unit of relative spot move; the drawer shows it per 1%.
 */
export function GexBody({ d }: { d: GexData }): JSX.Element {
  const t = useT();
  const net = d.netGex;
  const perPct = net === null ? null : net * 0.01;
  let sign = '';
  if (net !== null) {
    if (net > 0) sign = t('research.gex.long');
    else if (net < 0) sign = t('research.gex.short');
    else sign = t('research.gex.neutral');
  }
  return (
    <>
      <div className="gex-summary-card">
        <div className="gex-stat">
          <span className="gex-stat__lbl">{t('research.gex.net')}</span>
          <span className={`gex-stat__val ${net !== null && net < 0 ? 'is-neg' : 'is-pos'}`}>{usdCompact(perPct)}</span>
          <span className="gex-stat__sub">{sign}</span>
        </div>
        <p className="intel-section__note">{t('research.gex.assumption')}</p>
        <div className="research-kv">
          <KeyValue label={t('research.gex.spot')} value={priceText(d.spot)} />
          <KeyValue label={t('research.gex.callWall')} value={priceText(d.callWall)} />
          <KeyValue label={t('research.gex.putWall')} value={priceText(d.putWall)} />
          <KeyValue label={t('research.gex.flip')} value={d.gammaFlip === null ? t('research.gex.noFlip') : priceText(d.gammaFlip)} />
          <KeyValue label={t('research.gex.putCall')} value={fixedOrDash(d.putCallOiRatio, 2)} />
          <KeyValue
            label={t('research.gex.maxPain')}
            value={priceText(d.maxPain)}
            sub={d.maxPainExpiry ? t('research.gex.expiry', { date: d.maxPainExpiry }) : undefined}
          />
        </div>
      </div>
    </>
  );
}

export function GexCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'gex', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<GexData>
      section="gex"
      source="Cboe delayed options"
      title={t('research.gex.title')}
      desc={t('research.gex.desc')}
      testId="research-gex"
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

export function ShortVolumeCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'short-volume', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<ShortVolumeData>
      section="short-volume"
      source="FINRA Reg SHO"
      title={t('research.short.title')}
      desc={t('research.short.desc')}
      testId="research-short-volume"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => {
        const ratio = d.shortRatio;
        const width = ratio === null ? 0 : Math.round(Math.max(0, Math.min(100, ratio * 100)) * 100) / 100;
        return (
          <>
            <p className="research-line">{t('research.short.date', { date: dayOrDash(d.date) })}</p>
            <div className="research-kv__row">
              <span className="research-kv__lbl">{t('research.short.ratio')}</span>
              <span className="research-kv__val">{pctOrDash(ratio === null ? null : ratio * 100, 1)}</span>
            </div>
            <div className="research-bar" role="img" aria-label={t('research.short.ratio')}>
              <div className="research-bar__fill" style={{ width: `${width}%` }} />
            </div>
            <div className="research-kv">
              <KeyValue label={t('research.short.avg5')} value={pctOrDash(d.avgShortRatio5d === null ? null : d.avgShortRatio5d * 100, 1)} />
              <KeyValue label={t('research.short.short')} value={quantityOrDash(d.shortVolume)} />
              <KeyValue label={t('research.short.exempt')} value={quantityOrDash(d.shortExemptVolume)} />
              <KeyValue label={t('research.short.total')} value={quantityOrDash(d.totalVolume)} />
            </div>
            <div className="research-block">
              <span className="research-kv__lbl">{t('research.short.days')}</span>
              {d.days.map((day, idx) => (
                <KeyValue
                  key={`${day.date ?? ''}-${idx}`}
                  label={dayOrDash(day.date)}
                  value={pctOrDash(day.shortRatio === null ? null : day.shortRatio * 100, 1)}
                />
              ))}
            </div>
          </>
        );
      }}
    </IntelSection>
  );
}

// ---- GEO ----

function trendText(t: TFn, status: HiringData['status']): string {
  if (status === 'expanding') return t('research.hire.expanding');
  if (status === 'slowing') return t('research.hire.slowing');
  if (status === 'steady') return t('research.hire.steady');
  return DASH;
}

export function HiringCard({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  const t = useT();
  const view = useResearchSection('us', 'hiring', symbol, { enabled: true, secContact: '' });
  return (
    <IntelSection<HiringData>
      section="hiring"
      source="Public job boards"
      title={t('research.hire.title')}
      desc={t('research.hire.desc')}
      testId="research-hiring"
      state={view.state}
      result={view.result}
      errorCode={view.errorCode}
      onRetry={view.refresh}
      onOpenSettings={onOpenSettings}
    >
      {(d) => (
        <>
          <p className="research-line">
            {d.boardUrl ? (
              <ExternalLink href={d.boardUrl} label={t('research.hire.board', { provider: d.provider ?? DASH })} />
            ) : (
              t('research.hire.board', { provider: d.provider ?? DASH })
            )}
          </p>
          <div className="research-kv">
            <KeyValue label={t('research.hire.total')} value={countOrDash(d.totalOpenings)} />
            <KeyValue label={t('research.hire.rd')} value={countOrDash(d.rdOpenings)} />
            <KeyValue
              label={t('research.hire.recent')}
              value={countOrDash(d.newLast30d)}
              sub={t('research.hire.prior', { count: countOrDash(d.newPrior30d) })}
            />
            <KeyValue label={t('research.hire.change')} value={signedPctOrDash(d.changePct, 1)} />
            <KeyValue label={t('research.hire.status')} value={trendText(t, d.status)} />
          </div>
        </>
      )}
    </IntelSection>
  );
}

/** The corporate jets section: no free source maps aircraft to listed companies, so it makes no request. */
export function JetsNote(): JSX.Element {
  const t = useT();
  return (
    <section className="intel-section" data-testid="research-jets">
      <div className="intel-section__head">
        <h3 className="intel-section__title">{t('research.jets.title')}</h3>
      </div>
      <p className="intel-empty">{t('research.jets.none')}</p>
    </section>
  );
}

// ---- tab panes ----

function Pane({ id, children }: { id: 'DOCS' | 'GOV' | 'FLOW' | 'GEO'; children: ReactNode }): JSX.Element {
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

export function IntelDocsPane({ symbol, secContact, onOpenSettings }: DocsPaneProps): JSX.Element {
  return (
    <Pane id="DOCS">
      <RiskFactorsCard symbol={symbol} secContact={secContact} onOpenSettings={onOpenSettings} />
      <ManagementLanguageCard symbol={symbol} secContact={secContact} onOpenSettings={onOpenSettings} />
    </Pane>
  );
}

export function IntelGovPane({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="GOV">
      <ContractsCard symbol={symbol} onOpenSettings={onOpenSettings} />
      <HouseTradesCard symbol={symbol} onOpenSettings={onOpenSettings} />
    </Pane>
  );
}

export function IntelFlowPane({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="FLOW">
      <GexCard symbol={symbol} onOpenSettings={onOpenSettings} />
      <ShortVolumeCard symbol={symbol} onOpenSettings={onOpenSettings} />
    </Pane>
  );
}

export function IntelGeoPane({ symbol, onOpenSettings }: ResearchCardProps): JSX.Element {
  return (
    <Pane id="GEO">
      <HiringCard symbol={symbol} onOpenSettings={onOpenSettings} />
      <JetsNote />
    </Pane>
  );
}
