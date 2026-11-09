/**
 * The fixed parts of the research drawer around its module panes: the title bar,
 * the active-symbol context bar and the list of received intelligence. Kept apart
 * from IntelligenceDrawer.tsx so the drawer reads as a composition of its parts.
 */

import type { RefObject } from 'react';
import { formatNumber } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { IntelligenceEvent } from '../state/intelligenceStore';
import { intelHeading, intelKindKey } from './IntelligenceDrawerEvents';

interface IntelDrawerHeaderProps {
  closeRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
}

export function IntelDrawerHeader({ closeRef, onClose }: IntelDrawerHeaderProps): JSX.Element {
  const t = useT();
  return (
    <div className="drawer__header intel-drawer__header">
      <div className="intel-drawer__title-group">
        <span className="intel-drawer__badge">{t('intel.badge')}</span>
        <h2 className="drawer__title intel-drawer__title">{t('intel.title')}</h2>
      </div>
      <button
        ref={closeRef}
        type="button"
        className="drawer__close"
        onClick={onClose}
        aria-label={t('intel.closeDrawer')}
        data-testid="intel-drawer-close"
      >
        ✕
      </button>
    </div>
  );
}

interface IntelContextBarProps {
  sym: string;
  filterActiveSymbol: boolean;
  onToggleFilter: () => void;
  onOpenSources?: () => void;
}

/** The active symbol, the switch that narrows every module to it, and the sources link. */
export function IntelContextBar({ sym, filterActiveSymbol, onToggleFilter, onOpenSources }: IntelContextBarProps): JSX.Element {
  const t = useT();
  return (
    <div className="intel-drawer__context-bar">
      <span className="intel-drawer__target">
        {t('intel.activeSymbol')} <strong>{sym}</strong>
      </span>
      <button
        type="button"
        className={`intel-filter-toggle${filterActiveSymbol ? ' is-on' : ''}`}
        onClick={onToggleFilter}
      >
        {filterActiveSymbol ? t('intel.filterOnly', { symbol: sym }) : t('intel.showAll')}
      </button>
      {onOpenSources && (
        <button
          type="button"
          className="intel-filter-toggle"
          onClick={onOpenSources}
          data-testid="intel-open-sources"
        >
          {t('intel.sourceDetails')}
        </button>
      )}
    </div>
  );
}

/** Records the sources delivered as received, with their source and amount. */
export function IntelReceivedEvents({ events }: { events: readonly IntelligenceEvent[] }): JSX.Element {
  const t = useT();
  return (
    <section className="intel-section" data-testid="intel-received-events">
      <h3 className="intel-section__title">{t('intel.receivedTitle')}</h3>
      {events.map((event) => {
        const kindKey = intelKindKey(event.kind);
        return (
          <article key={event.id} className="intel-card">
            <div className="intel-card__top">
              <span className="intel-card__sym">{event.symbol}</span>
              <span>{kindKey ? t(kindKey) : event.kind}</span>
              <span>{event.source || t('intel.sourceMissing')}</span>
            </div>
            <div className="intel-card__heading">{intelHeading(event, t)}</div>
            {event.amountUsd !== undefined && (
              <div>{t('intel.amount', { amount: `$${formatNumber(event.amountUsd)}` })}</div>
            )}
          </article>
        );
      })}
    </section>
  );
}
