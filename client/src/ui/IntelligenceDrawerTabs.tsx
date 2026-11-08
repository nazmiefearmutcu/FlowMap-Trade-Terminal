import { useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { useT } from '../i18n/useT';
import type { IntelTab } from '../state/intelligenceStore';

const TABS: ReadonlyArray<{ id: IntelTab; hintKey: string }> = [
  { id: 'DOCS', hintKey: 'intel.tab.docsHint' },
  { id: 'GOV', hintKey: 'intel.tab.govHint' },
  { id: 'FLOW', hintKey: 'intel.tab.flowHint' },
  { id: 'GEO', hintKey: 'intel.tab.geoHint' },
];

interface IntelTabListProps {
  activeTab: IntelTab;
  onSelect: (tab: IntelTab) => void;
}

/**
 * The research drawer's tab strip (WAI-ARIA tabs with roving focus). Arrow keys,
 * Home and End move the selection and the focus together.
 */
export function IntelTabList({ activeTab, onSelect }: IntelTabListProps): JSX.Element {
  const t = useT();
  const tabRefs = useRef<Partial<Record<IntelTab, HTMLButtonElement | null>>>({});

  const onTabListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const idx = TABS.findIndex((tab) => tab.id === activeTab);
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
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
      {TABS.map((tab) => {
        const selected = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[tab.id] = el;
            }}
            type="button"
            role="tab"
            id={`intel-tab-${tab.id}`}
            aria-selected={selected}
            // Only the selected tab's panel is rendered, so only it can be referenced.
            aria-controls={selected ? `intel-panel-${tab.id}` : undefined}
            tabIndex={selected ? 0 : -1}
            className={`intel-tab${selected ? ' is-active' : ''}`}
            onClick={() => onSelect(tab.id)}
            data-testid={`tab-${tab.id.toLowerCase()}`}
          >
            {tab.id}
            <span className="intel-tab__hint">{t(tab.hintKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
