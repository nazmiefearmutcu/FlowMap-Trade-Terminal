import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../i18n/useT';
import type { IntelTab } from '../state/intelligenceStore';

/** Tabs for a US stock. */
export const EQUITY_TABS: readonly IntelTab[] = ['DOCS', 'GOV', 'FLOW', 'GEO'];
/** Tabs for a crypto symbol. */
export const CRYPTO_TABS: readonly IntelTab[] = ['PERP', 'OPTIONS', 'MARKET', 'SENTIMENT'];

const HINT_KEYS: Readonly<Record<IntelTab, string>> = {
  DOCS: 'research.tab.hint.DOCS',
  GOV: 'research.tab.hint.GOV',
  FLOW: 'research.tab.hint.FLOW',
  GEO: 'research.tab.hint.GEO',
  PERP: 'research.tab.hint.PERP',
  OPTIONS: 'research.tab.hint.OPTIONS',
  MARKET: 'research.tab.hint.MARKET',
  SENTIMENT: 'research.tab.hint.SENTIMENT',
};

/**
 * The tabs of a market group: `equity` (US stocks), `crypto`, or none for any
 * other market (the drawer then says research does not cover it).
 */
export function tabsFor(group: string | null): readonly IntelTab[] {
  if (group === 'equity') return EQUITY_TABS;
  if (group === 'crypto') return CRYPTO_TABS;
  return [];
}

/** The tab to show: the active one when the set has it, else the set's first tab. */
export function resolveTab(active: IntelTab, tabs: readonly IntelTab[]): IntelTab | null {
  if (tabs.length === 0) return null;
  return tabs.includes(active) ? active : tabs[0];
}

interface IntelTabListProps {
  tabs: readonly IntelTab[];
  activeTab: IntelTab;
  onSelect: (tab: IntelTab) => void;
}

/**
 * The research drawer's tab strip (WAI-ARIA tabs with roving focus). Arrow keys,
 * Home and End move the selection and the focus together.
 */
export function IntelTabList({ tabs, activeTab, onSelect }: IntelTabListProps): JSX.Element {
  const t = useT();
  const tabRefs = useRef<Partial<Record<IntelTab, HTMLButtonElement | null>>>({});

  const onTabListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const idx = tabs.indexOf(activeTab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = tabs[next];
    onSelect(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <div
      className="intel-drawer__tabs"
      role="tablist"
      aria-label={t('intel.title')}
      onKeyDown={onTabListKeyDown}
    >
      {tabs.map((id) => {
        const selected = activeTab === id;
        return (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el;
            }}
            type="button"
            role="tab"
            id={`intel-tab-${id}`}
            aria-selected={selected}
            // Only the selected tab's panel is rendered, so only it can be referenced.
            aria-controls={selected ? `intel-panel-${id}` : undefined}
            tabIndex={selected ? 0 : -1}
            className={`intel-tab${selected ? ' is-active' : ''}`}
            onClick={() => onSelect(id)}
            data-testid={`tab-${id.toLowerCase()}`}
          >
            {id}
            <span className="intel-tab__hint">{t(HINT_KEYS[id])}</span>
          </button>
        );
      })}
    </div>
  );
}
