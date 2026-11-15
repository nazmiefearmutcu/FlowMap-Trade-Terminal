/**
 * Research drawer.
 *
 * Every section reads a real, free public source through the server
 * (`/api/research/{market}/{section}`), and says plainly why it has no data for
 * a symbol. A US stock gets DOCS, GOV, FLOW and GEO; a crypto symbol gets PERP,
 * OPTIONS, MARKET and SENTIMENT; any other market gets a note that research does
 * not cover it yet. Only the visible tab asks the server.
 *
 * The tab strip, the macro footer, the received-events list and the dialog focus
 * handling live in IntelligenceDrawerTabs, IntelligenceDrawerMacro,
 * IntelligenceDrawerChrome and IntelligenceDrawerFocus.
 */

import { useRef, useState } from 'react';
import { useT } from '../i18n/useT';
import { useIntelligenceStore } from '../state/intelligenceStore';
import {
  IntelMarketPane,
  IntelOptionsPane,
  IntelPerpPane,
  IntelSentimentPane,
} from './IntelligenceDrawerCrypto';
import { IntelDocsPane, IntelFlowPane, IntelGeoPane, IntelGovPane } from './IntelligenceDrawerPanes';
import { IntelMacroBar } from './IntelligenceDrawerMacro';
import { useIntelDrawerFocus } from './IntelligenceDrawerFocus';
import { IntelContextBar, IntelDrawerHeader, IntelReceivedEvents } from './IntelligenceDrawerChrome';
import { IntelTabList, resolveTab, tabsFor } from './IntelligenceDrawerTabs';
import { marketGroup } from './symbols';
import './IntelligenceDrawer.css';

interface IntelligenceDrawerProps {
  activeSymbol: string;
  /** Market of the active symbol. Markets other than US stocks and crypto get the not-covered note. */
  activeMarket?: string | null;
  /** The user's SEC contact e-mail (Settings → Data); sent to the server on the SEC sections only. */
  secContact?: string;
  /** Opens the settings drawer, for the one section that needs the contact. Omitted: the words are shown. */
  onOpenSettings?: () => void;
  /**
   * Opens the data-sources and legal dialog. There is no source
   * management UI yet: the sources are listed, with their terms, in About.
   */
  onOpenSources?: () => void;
  onClose: () => void;
}

export function IntelligenceDrawer({
  activeSymbol,
  activeMarket = null,
  secContact = '',
  onOpenSettings,
  onOpenSources,
  onClose,
}: IntelligenceDrawerProps) {
  const t = useT();
  const activeTab = useIntelligenceStore((s) => s.activeTab);
  const setActiveTab = useIntelligenceStore((s) => s.setActiveTab);
  const macro = useIntelligenceStore((s) => s.macro);
  const events = useIntelligenceStore((s) => s.events);

  const [filterActiveSymbol, setFilterActiveSymbol] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onTrapKeyDown = useIntelDrawerFocus({ drawerRef, closeRef, onClose });

  const sym = activeSymbol.toUpperCase();
  const group = activeMarket === null ? null : marketGroup(activeMarket);
  const tabs = tabsFor(group);
  // A tab from the other market's set falls back to the first tab of this one.
  const tab = resolveTab(activeTab, tabs);
  // Crypto symbols are sent as the chart shows them (the server strips the quote); equities in upper case.
  const requestSymbol = group === 'crypto' ? activeSymbol : sym;

  const filteredEvents = filterActiveSymbol ? events.filter((event) => event.symbol === sym) : events;

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

        {tab !== null && <IntelTabList tabs={tabs} activeTab={tab} onSelect={setActiveTab} />}

        {/* Active Symbol Context & Filter Switch */}
        <IntelContextBar
          sym={sym}
          filterActiveSymbol={filterActiveSymbol}
          onToggleFilter={() => setFilterActiveSymbol(!filterActiveSymbol)}
          onOpenSources={onOpenSources}
        />

        <div className="drawer__body intel-drawer__body">
          {tab === null && (
            <p className="intel-hidden" data-testid="intel-not-covered">{t('research.notCovered')}</p>
          )}
          {filteredEvents.length > 0 && <IntelReceivedEvents events={filteredEvents} />}

          {tab === 'DOCS' && (
            <IntelDocsPane symbol={requestSymbol} secContact={secContact} onOpenSettings={onOpenSettings} />
          )}
          {tab === 'GOV' && <IntelGovPane symbol={requestSymbol} onOpenSettings={onOpenSettings} />}
          {tab === 'FLOW' && <IntelFlowPane symbol={requestSymbol} onOpenSettings={onOpenSettings} />}
          {tab === 'GEO' && <IntelGeoPane symbol={requestSymbol} onOpenSettings={onOpenSettings} />}
          {tab === 'PERP' && <IntelPerpPane symbol={requestSymbol} />}
          {tab === 'OPTIONS' && <IntelOptionsPane symbol={requestSymbol} onOpenSettings={onOpenSettings} />}
          {tab === 'MARKET' && <IntelMarketPane symbol={requestSymbol} />}
          {tab === 'SENTIMENT' && <IntelSentimentPane symbol={requestSymbol} />}
        </div>

        <IntelMacroBar macro={macro} />
      </aside>
    </>
  );
}
