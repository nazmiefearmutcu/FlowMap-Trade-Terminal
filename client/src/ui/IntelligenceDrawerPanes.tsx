/**
 * Tab panes of the Research drawer (IntelligenceDrawer.tsx). Each pane renders one
 * tab's modules. A module is shown only when its source has delivered data;
 * modules without data are listed as hidden, and a filtered list with no match
 * says so. Outputs are heuristics, and the copy says so.
 */

import { formatFixed, formatNumber, formatPrice } from '../i18n/format';
import { useT } from '../i18n/useT';
import type {
  CapitolTradeData,
  ContractData,
  CorporateJetData,
  DarkPoolData,
  GexData,
  SecDiffData,
  TalentData,
  VocalStressData,
} from '../state/intelligenceStore';

/** Which modules have delivered data. Unconnected modules are hidden. */
export interface IntelConnected {
  sec: boolean;
  acoustics: boolean;
  contracts: boolean;
  capitol: boolean;
  gex: boolean;
  darkPool: boolean;
  jets: boolean;
  talent: boolean;
}

/** Names of the modules a tab hides, shown as one line above the tab's content. */
export function IntelHiddenModules({ names }: { names: string[] }): JSX.Element | null {
  const t = useT();
  if (names.length === 0) return null;
  return (
    <p className="intel-hidden" data-testid="intel-hidden-modules">
      {t('intel.hiddenModules', { count: names.length, names: names.join(', ') })}
    </p>
  );
}

/** Shown in place of a module's list when the active filter matches nothing. */
export function IntelNoMatches({ source, symbol }: { source: string; symbol: string }): JSX.Element {
  const t = useT();
  return (
    <div className="intel-empty" data-testid="intel-no-matches">
      {t('intel.noMatches', { source, symbol })}
    </div>
  );
}

interface IntelPaneCommonProps {
  sym: string;
  connected: IntelConnected;
  hiddenNames: string[];
}

export function IntelDocsPane({ sym, connected, hiddenNames, filteredDiffs, filteredStress }: IntelPaneCommonProps & { filteredDiffs: SecDiffData[]; filteredStress: VocalStressData[] }): JSX.Element {
  const t = useT();
  return (
    <div className="intel-tab-pane" data-testid="pane-docs" role="tabpanel" id="intel-panel-DOCS" aria-labelledby="intel-tab-DOCS" tabIndex={0}>
      <IntelHiddenModules names={hiddenNames} />
      {connected.sec && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.sec')}</span>
            <h3 className="intel-section__title">{t('intel.title.secDiff')}</h3>
          </div>
          <p className="intel-section__desc">{t('intel.secDesc')}</p>

          {filteredDiffs.length === 0 ? (
            <IntelNoMatches source={t('intel.src.sec')} symbol={sym} />
          ) : (
            filteredDiffs.map((diff) => (
              <article key={diff.id} className="intel-card intel-card--diff">
                <div className="intel-card__top">
                  <span className="intel-card__sym">{diff.symbol}</span>
                  <span className="intel-card__form">{diff.filingType}</span>
                  <span className="intel-card__date">{diff.filedDate}</span>
                </div>
                <div className="intel-card__heading">{diff.title}</div>
                {diff.criticalTriggers.length > 0 && (
                  <div className="intel-triggers">
                    {diff.criticalTriggers.map((trig) => (
                      <span key={trig} className="intel-trigger-badge">
                        {trig}
                      </span>
                    ))}
                  </div>
                )}
                <div className="intel-diff-box">
                  {diff.removedLines.map((line, idx) => (
                    <div key={idx} className="diff-line diff-line--del">
                      {line}
                    </div>
                  ))}
                  {diff.addedLines.map((line, idx) => (
                    <div key={idx} className="diff-line diff-line--add">
                      {line}
                    </div>
                  ))}
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {connected.acoustics && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.acoustics')}</span>
            <h3 className="intel-section__title">{t('intel.title.acoustics')}</h3>
          </div>
          <p className="intel-section__desc">
            {t('intel.acousticDesc')}
          </p>

          {filteredStress.length === 0 && <IntelNoMatches source={t('intel.src.acoustics')} symbol={sym} />}
          {filteredStress.map((voc) => {
            const pct = Math.round(voc.stressScore * 100);
            const isHigh = voc.stressScore >= 0.6;
            return (
              <article key={voc.id} className="intel-card intel-card--vocal">
                <div className="intel-card__top">
                  <span className="intel-card__sym">{voc.symbol}</span>
                  <span className="intel-card__speaker">{voc.executive}</span>
                  <span className="intel-card__date">{voc.quarter}</span>
                </div>
                <div className="vocal-metrics-grid">
                  <div className="vocal-metric">
                    <span className="vocal-metric__lbl">{t('intel.metric.heuristicScore')}</span>
                    <span className={`vocal-metric__val${isHigh ? ' is-alert' : ''}`}>
                      {pct}%
                    </span>
                  </div>
                  <div className="vocal-metric">
                    <span className="vocal-metric__lbl">{t('intel.metric.pitchJitter')}</span>
                    <span className="vocal-metric__val">{formatFixed(voc.f0Jitter * 100, 2)}%</span>
                  </div>
                  <div className="vocal-metric">
                    <span className="vocal-metric__lbl">{t('intel.metric.shimmer')}</span>
                    <span className="vocal-metric__val">{formatFixed(voc.shimmer * 100, 2)}%</span>
                  </div>
                  <div className="vocal-metric">
                    <span className="vocal-metric__lbl">{t('intel.metric.pauseRatio')}</span>
                    <span className="vocal-metric__val">{formatFixed(voc.pauseRatio * 100, 1)}%</span>
                  </div>
                </div>
                {voc.evasiveAnswersDetected > 0 && (
                  <div className="intel-triggers">
                    <span className="intel-trigger-badge is-warn">
                      {t('intel.phraseMatches', { count: formatNumber(voc.evasiveAnswersDetected) })}
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

export function IntelGovPane({ sym, connected, hiddenNames, filteredContracts, filteredTrades }: IntelPaneCommonProps & { filteredContracts: ContractData[]; filteredTrades: CapitolTradeData[] }): JSX.Element {
  const t = useT();
  const chamberName = (chamber: 'Senate' | 'House'): string =>
    chamber === 'Senate' ? t('intel.chamber.senate') : t('intel.chamber.house');
  return (
    <div className="intel-tab-pane" data-testid="pane-gov" role="tabpanel" id="intel-panel-GOV" aria-labelledby="intel-tab-GOV" tabIndex={0}>
      <IntelHiddenModules names={hiddenNames} />
      {connected.contracts && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.gov')}</span>
            <h3 className="intel-section__title">{t('intel.title.gov')}</h3>
          </div>
          <p className="intel-section__desc">{t('intel.govDesc')}</p>

          {filteredContracts.length === 0 && <IntelNoMatches source={t('intel.src.usaspending')} symbol={sym} />}
          {filteredContracts.map((c) => (
            <article key={c.id} className="intel-card intel-card--contract">
              <div className="intel-card__top">
                <span className="intel-card__sym">{c.symbol}</span>
                <span className="intel-card__amount">
                  {c.amount === undefined ? t('intel.amountMissing') : `$${formatNumber(c.amount / 1_000_000, { maximumFractionDigits: 1 })}M`}
                </span>
                <span className="intel-card__date">{c.date ?? t('intel.dateMissing')}</span>
              </div>
              {(c.recipient || c.agency) && <div className="intel-card__recipient">{[c.recipient, c.agency].filter(Boolean).join(' · ')}</div>}
              <div className="intel-card__desc">{c.description}</div>
              {c.awardId && <div className="intel-card__award-id">{t('intel.awardId', { id: c.awardId })}</div>}
            </article>
          ))}
        </section>
      )}

      {connected.capitol && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.capitol')}</span>
            <h3 className="intel-section__title">{t('intel.title.capitol')}</h3>
          </div>
          <p className="intel-section__desc">
            {t('intel.capitolDesc')}
          </p>

          {filteredTrades.length === 0 && <IntelNoMatches source={t('intel.src.house')} symbol={sym} />}
          {filteredTrades.map((tr) => (
            <article key={tr.id} className="intel-card intel-card--capitol">
              <div className="intel-card__top">
                <span className="intel-card__sym">{tr.symbol}</span>
                {tr.transactionType && <span className={`intel-card__side is-${tr.transactionType.toLowerCase()}`}>
                  {t(tr.transactionType === 'Sale' ? 'intel.trade.sale' : 'intel.trade.purchase')}
                </span>}
                <span className="intel-card__date">{tr.date ?? t('intel.dateMissing')}</span>
              </div>
              {(tr.politician || tr.chamber) && <div className="intel-card__politician">
                <strong>{tr.politician}</strong> {tr.chamber && `(${chamberName(tr.chamber)})`}
              </div>}
              {tr.committee && <div className="intel-card__committee">{t('intel.committee', { committee: tr.committee })}</div>}
              {tr.amountRange && <div className="intel-card__amount-range">{t('intel.amount', { amount: tr.amountRange })}</div>}
            </article>
          ))}
        </section>
      )}
    </div>
  );
}

export function IntelFlowPane({ sym, connected, hiddenNames, currentGex, currentDarkPool }: IntelPaneCommonProps & { currentGex: GexData | undefined; currentDarkPool: DarkPoolData | undefined }): JSX.Element {
  const t = useT();
  return (
    <div className="intel-tab-pane" data-testid="pane-flow" role="tabpanel" id="intel-panel-FLOW" aria-labelledby="intel-tab-FLOW" tabIndex={0}>
      <IntelHiddenModules names={hiddenNames} />
      {connected.gex && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.gex')}</span>
            <h3 className="intel-section__title">{t('intel.title.gex')}</h3>
          </div>
          <p className="intel-section__desc">
            {t('intel.gexDesc')}
          </p>

          {!currentGex && <IntelNoMatches source={t('intel.src.gex')} symbol={sym} />}
          {currentGex && (
            <div className="gex-summary-card">
              <div className="gex-stat">
                <span className="gex-stat__lbl">{t('intel.gex.net')}</span>
                <span className={`gex-stat__val ${currentGex.netGex >= 0 ? 'is-pos' : 'is-neg'}`}>
                  {t('intel.gexValue', { value: `${currentGex.netGex >= 0 ? '+' : ''}$${formatFixed(currentGex.netGex / 1_000_000, 1)}M` })}
                </span>
                <span className="gex-stat__sub">
                  {currentGex.netGex >= 0 ? t('intel.gexPositive') : t('intel.gexNegative')}
                </span>
              </div>

              <div className="gex-levels-grid">
                <div className="gex-level-item is-call">
                  <span className="gex-level-item__name">{t('intel.gex.callWall')}</span>
                  <span className="gex-level-item__px">${formatPrice(currentGex.callWall, 2)}</span>
                  <span className="gex-level-item__note">{t('intel.gexCallNote')}</span>
                </div>
                <div className="gex-level-item is-put">
                  <span className="gex-level-item__name">{t('intel.gex.putWall')}</span>
                  <span className="gex-level-item__px">${formatPrice(currentGex.putWall, 2)}</span>
                  <span className="gex-level-item__note">{t('intel.gexPutNote')}</span>
                </div>
                <div className="gex-level-item is-flip">
                  <span className="gex-level-item__name">{t('intel.gex.flip')}</span>
                  <span className="gex-level-item__px">${formatPrice(currentGex.gammaFlip, 2)}</span>
                  <span className="gex-level-item__note">{t('intel.gexFlipNote')}</span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {connected.darkPool && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.regSho')}</span>
            <h3 className="intel-section__title">{t('intel.title.regSho')}</h3>
          </div>
          <p className="intel-section__desc">{t('intel.shortSaleDesc')}</p>

          {!currentDarkPool && <IntelNoMatches source={t('intel.src.regSho')} symbol={sym} />}
          {currentDarkPool && (
            <div className="darkpool-card">
              <div className="darkpool-row">
                <span className="darkpool-lbl">{t('intel.shortSaleShare')}</span>
                <strong className={`darkpool-ratio ${currentDarkPool.shortRatio > 0.5 ? 'is-high' : ''}`}>
                  {formatFixed(currentDarkPool.shortRatio * 100, 1)}%
                </strong>
              </div>
              <div className="darkpool-bar">
                <div
                  className="darkpool-bar__fill"
                  style={{ width: `${Math.min(100, currentDarkPool.shortRatio * 100)}%` }}
                />
              </div>
              <div className="darkpool-details">
                <div>{t('intel.totalVolume', { volume: formatNumber(currentDarkPool.totalVolume) })}</div>
                <div>{t('intel.shortSaleVolume', { volume: formatNumber(currentDarkPool.shortVolume) })}</div>
                <div>{t('intel.otcNonAts', { volume: formatNumber(currentDarkPool.otcVolume) })}</div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export function IntelGeoPane({ sym, connected, hiddenNames, filteredJets, currentTalent }: IntelPaneCommonProps & { filteredJets: CorporateJetData[]; currentTalent: TalentData | undefined }): JSX.Element {
  const t = useT();
  return (
    <div className="intel-tab-pane" data-testid="pane-geo" role="tabpanel" id="intel-panel-GEO" aria-labelledby="intel-tab-GEO" tabIndex={0}>
      <IntelHiddenModules names={hiddenNames} />
      {connected.jets && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.adsb')}</span>
            <h3 className="intel-section__title">{t('intel.title.jets')}</h3>
          </div>
          <p className="intel-section__desc">{t('intel.geoDesc')}</p>

          {filteredJets.length === 0 && <IntelNoMatches source={t('intel.src.adsb')} symbol={sym} />}
          {filteredJets.map((j) => (
            <article key={j.id} className="intel-card intel-card--jet">
              <div className="intel-card__top">
                <span className="intel-card__sym">{j.symbol}</span>
                <span className="intel-card__tail">{j.tailNumber} {j.icao24 && `(${j.icao24})`}</span>
                <span className="intel-card__date">{j.date ?? t('intel.dateMissing')}</span>
              </div>
              {(j.origin || j.destination) && <div className="intel-jet-route">
                <span>{j.origin}</span>
                <span className="intel-jet-arrow">──▶</span>
                <span>{j.destination}</span>
              </div>}
              {j.isMaHub && j.hubName && (
                <div className="intel-triggers">
                  <span className="intel-trigger-badge is-alert">
                    {t('intel.hubVisit', { hub: j.hubName })}
                  </span>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {connected.talent && (
        <section className="intel-section">
          <div className="intel-section__head">
            <span className="intel-section__tag">{t('intel.tag.talent')}</span>
            <h3 className="intel-section__title">{t('intel.title.talent')}</h3>
          </div>
          <p className="intel-section__desc">{t('intel.talentDesc')}</p>

          {!currentTalent && <IntelNoMatches source={t('intel.src.headcount')} symbol={sym} />}
          {currentTalent && (
            <div className="talent-card">
              <div className="talent-row">
                <span>{t('intel.talentMomentum')}</span>
                <strong className={`talent-delta ${currentTalent.talentDeltaPct >= 0 ? 'is-pos' : 'is-neg'}`}>
                  {currentTalent.talentDeltaPct >= 0 ? '+' : ''}
                  {formatFixed(currentTalent.talentDeltaPct, 1)}%
                </strong>
              </div>
              <div className="talent-stats-grid">
                <div>{t('intel.rdOpenings')} <strong>{formatNumber(currentTalent.rdOpenings)}</strong></div>
                <div>{t('intel.totalListings')} <strong>{formatNumber(currentTalent.totalOpenings)}</strong></div>
                <div>
                  {t('intel.status')}{' '}
                  <span className={`talent-badge ${currentTalent.hiringFreeze ? 'is-freeze' : 'is-active'}`}>
                    {currentTalent.hiringFreeze ? t('intel.hiringFreeze') : t('intel.expanding')}
                  </span>
                </div>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
