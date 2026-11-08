/**
 * Research drawer.
 *
 * Multi-module research drawer. Every module names its source, says what it
 * measures and what it cannot establish, and is hidden (and counted) while no
 * source has delivered data for it. Nothing here is shown as live or as an
 * institutional signal: outputs are heuristics, and the copy says so.
 * - DOCS: SEC EDGAR Item 1A line diffs & earnings-call acoustic heuristics.
 * - GOV:  USASpending.gov award notices & House disclosure trades.
 * - FLOW: option-chain GEX model levels & Reg SHO short-sale volume share.
 * - GEO:  ADS-B aircraft positions & open-role headcount change.
 * - MACRO footer: SOFR, HY OAS, 10Y-2Y, and a heuristic stress regime.
 *
 * Synthetic fixtures (DEMO_INTELLIGENCE) appear only for SIM-DEMO in a
 * development build. A shipped build shows the sources it actually received.
 * Every label reads through i18n; the source and dataset names are
 * proper nouns and stay as published.
 *
 * The tab strip, the macro footer and the dialog focus handling live in
 * IntelligenceDrawerTabs, IntelligenceDrawerMacro and IntelligenceDrawerFocus.
 */

import { useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { DEMO_INTELLIGENCE, useIntelligenceStore } from '../state/intelligenceStore';
import {
  IntelDocsPane,
  IntelFlowPane,
  IntelGeoPane,
  IntelGovPane,
} from './IntelligenceDrawerPanes';
import { IntelMacroBar } from './IntelligenceDrawerMacro';
import { useIntelDrawerFocus } from './IntelligenceDrawerFocus';
import { IntelContextBar, IntelDrawerHeader, IntelReceivedEvents } from './IntelligenceDrawerChrome';
import { IntelTabList } from './IntelligenceDrawerTabs';
import { marketGroup } from './symbols';
import './IntelligenceDrawer.css';

interface IntelligenceDrawerProps {
  activeSymbol: string;
  /** Market of the active symbol. Crypto symbols get the equity-only note. */
  activeMarket?: string | null;
  /**
   * Opens the data-sources and legal dialog. There is no source
   * management UI yet: the sources are listed, with their terms, in About.
   */
  onOpenSources?: () => void;
  onClose: () => void;
}

export function IntelligenceDrawer({ activeSymbol, activeMarket = null, onOpenSources, onClose }: IntelligenceDrawerProps) {
  const t = useT();
  const activeTab = useIntelligenceStore((s) => s.activeTab);
  const setActiveTab = useIntelligenceStore((s) => s.setActiveTab);

  const liveGex = useIntelligenceStore((s) => s.gex);
  const liveDarkPool = useIntelligenceStore((s) => s.darkPool);
  const liveDiffs = useIntelligenceStore((s) => s.secDiffs);
  const liveStress = useIntelligenceStore((s) => s.vocalStress);
  const liveContracts = useIntelligenceStore((s) => s.contracts);
  const liveTrades = useIntelligenceStore((s) => s.capitolTrades);
  const liveJets = useIntelligenceStore((s) => s.corporateJets);
  const liveTalent = useIntelligenceStore((s) => s.talent);
  const liveMacro = useIntelligenceStore((s) => s.macro);
  const events = useIntelligenceStore((s) => s.events);

  const [filterActiveSymbol, setFilterActiveSymbol] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onTrapKeyDown = useIntelDrawerFocus({ drawerRef, closeRef, onClose });

  const sym = activeSymbol.toUpperCase();
  // The modules are equity and option research sources; crypto has no matching records.
  const equityOnly = activeMarket !== null && marketGroup(activeMarket) === 'crypto';
  // Synthetic fixtures are a development aid only. A shipped build never shows
  // them, even for SIM-DEMO, so no invented filing or award can reach a user.
  const demo = import.meta.env.DEV && sym === 'SIM-DEMO';
  const fixtures = demo ? DEMO_INTELLIGENCE : null;
  const currentGex = fixtures ? fixtures.gex[sym] : liveGex[sym];
  const currentDarkPool = fixtures ? fixtures.darkPool[sym] : liveDarkPool[sym];
  const currentTalent = fixtures ? fixtures.talent[sym] : liveTalent[sym];
  const secDiffs = fixtures ? fixtures.secDiffs : liveDiffs;
  const vocalStress = fixtures ? fixtures.vocalStress : liveStress;
  const contracts = fixtures ? fixtures.contracts : liveContracts;
  const capitolTrades = fixtures ? fixtures.capitolTrades : liveTrades;
  const corporateJets = fixtures ? fixtures.corporateJets : liveJets;
  const macro = fixtures ? fixtures.macro : liveMacro;

  // A module is "connected" once its source has delivered anything (for the
  // per-symbol modules: anything for any symbol). Unconnected modules are hidden.
  const connected = {
    sec: fixtures !== null || liveDiffs.length > 0,
    acoustics: fixtures !== null || liveStress.length > 0,
    contracts: fixtures !== null || liveContracts.length > 0,
    capitol: fixtures !== null || liveTrades.length > 0,
    gex: fixtures !== null || Object.keys(liveGex).length > 0,
    darkPool: fixtures !== null || Object.keys(liveDarkPool).length > 0,
    jets: fixtures !== null || liveJets.length > 0,
    talent: fixtures !== null || Object.keys(liveTalent).length > 0,
  };

  const filteredDiffs = filterActiveSymbol ? secDiffs.filter((d) => d.symbol === sym) : secDiffs;
  const filteredStress = filterActiveSymbol ? vocalStress.filter((v) => v.symbol === sym) : vocalStress;
  const filteredContracts = filterActiveSymbol ? contracts.filter((c) => c.symbol === sym) : contracts;
  const filteredTrades = filterActiveSymbol ? capitolTrades.filter((tr) => tr.symbol === sym) : capitolTrades;
  const filteredJets = filterActiveSymbol ? corporateJets.filter((j) => j.symbol === sym) : corporateJets;
  const filteredEvents = filterActiveSymbol ? events.filter((event) => event.symbol === sym) : events;

  const docsHidden: string[] = [];
  if (!connected.sec) docsHidden.push(t('intel.src.sec'));
  if (!connected.acoustics) docsHidden.push(t('intel.src.acoustics'));
  const govHidden: string[] = [];
  if (!connected.contracts) govHidden.push(t('intel.src.usaspending'));
  if (!connected.capitol) govHidden.push(t('intel.src.house'));
  const flowHidden: string[] = [];
  if (!connected.gex) flowHidden.push(t('intel.src.gex'));
  if (!connected.darkPool) flowHidden.push(t('intel.src.regSho'));
  const geoHidden: string[] = [];
  if (!connected.jets) geoHidden.push(t('intel.src.adsb'));
  if (!connected.talent) geoHidden.push(t('intel.src.headcount'));

  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <aside
        ref={drawerRef}
        className="drawer intel-drawer"
        role="dialog"
        aria-label={t('intel.title')}
        aria-modal="true"
        data-testid="intelligence-drawer"
        onKeyDown={onTrapKeyDown}
      >
        <IntelDrawerHeader closeRef={closeRef} onClose={onClose} />

        <IntelTabList activeTab={activeTab} onSelect={setActiveTab} />

        {/* Active Symbol Context & Filter Switch */}
        <IntelContextBar
          sym={sym}
          filterActiveSymbol={filterActiveSymbol}
          onToggleFilter={() => setFilterActiveSymbol(!filterActiveSymbol)}
          onOpenSources={onOpenSources}
        />

        <div className="drawer__body intel-drawer__body">
          {demo && (
            <div className="intel-empty" data-testid="intel-demo-label">
              {t('intel.demoFixtures')}
            </div>
          )}
          {equityOnly && (
            <p className="intel-hidden" data-testid="intel-equity-only">{t('intel.equityOnly')}</p>
          )}
          {!demo && filteredEvents.length > 0 && <IntelReceivedEvents events={filteredEvents} />}

          {/* TAB 1: DOCS */}
          {activeTab === 'DOCS' && (
            <IntelDocsPane
              sym={sym}
              connected={connected}
              hiddenNames={docsHidden}
              filteredDiffs={filteredDiffs}
              filteredStress={filteredStress}
            />
          )}

          {/* TAB 2: GOV */}
          {activeTab === 'GOV' && (
            <IntelGovPane
              sym={sym}
              connected={connected}
              hiddenNames={govHidden}
              filteredContracts={filteredContracts}
              filteredTrades={filteredTrades}
            />
          )}

          {/* TAB 3: FLOW */}
          {activeTab === 'FLOW' && (
            <IntelFlowPane
              sym={sym}
              connected={connected}
              hiddenNames={flowHidden}
              currentGex={currentGex}
              currentDarkPool={currentDarkPool}
            />
          )}

          {/* TAB 4: GEO */}
          {activeTab === 'GEO' && (
            <IntelGeoPane
              sym={sym}
              connected={connected}
              hiddenNames={geoHidden}
              filteredJets={filteredJets}
              currentTalent={currentTalent}
            />
          )}

        </div>

        <IntelMacroBar macro={macro} demo={demo} />
      </aside>
    </>
  );
}
