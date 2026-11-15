/**
 * Settings → Markets: every market this build can open, grouped (crypto, US stocks,
 * world exchanges, futures, currencies, indices, bonds, simulation), each with a
 * checkbox. A group's own checkbox switches the whole group; its count says how many
 * of its markets are on. A market's Browse button opens the symbol palette on that
 * market's listing, so every market can be looked through from here.
 *
 * The list comes from `GET /api/venues` (the same catalog the palette reads). The
 * choice is stored in the settings (`hiddenMarkets`, see `marketFilter.ts`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useT } from '../i18n/useT';
import {
  MARKET_GROUPS,
  groupState,
  marketFilter,
  marketGroupOf,
  setGroupVisible,
  setMarketVisible,
  type MarketGroup,
} from './marketFilter';
import type { FlowMapSettings } from './settings';
import './SettingsDrawerMarkets.css';
import { useVenueCatalog } from './SymbolSearchHooks';
import { ALL_VENUES, searchFold, venueOptions, type VenueOption } from './symbols';

interface MarketsSectionProps {
  hiddenMarkets: string[];
  onChange: (patch: Partial<FlowMapSettings>) => void;
  /** Open the symbol palette on one market's listing (closes the drawer). */
  onBrowseMarket?: (market: string) => void;
}

/** The catalog's markets by group, in catalog order. */
export function marketsByGroup(options: readonly VenueOption[]): Map<MarketGroup, VenueOption[]> {
  const out = new Map<MarketGroup, VenueOption[]>(MARKET_GROUPS.map((group) => [group, []]));
  for (const option of options) {
    if (option.market === ALL_VENUES) continue;
    out.get(marketGroupOf(option.market))?.push(option);
  }
  return out;
}

/** A group checkbox that shows the mixed state (some markets on, some off). */
function GroupCheckbox({ state, label, onToggle, group }: {
  state: 'all' | 'some' | 'none';
  label: string;
  onToggle: (visible: boolean) => void;
  group: MarketGroup;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      aria-label={label}
      data-testid={`markets-group-${group}`}
      // A click on the box must not also open or close the group it sits in.
      onClick={(e) => e.stopPropagation()}
      onChange={() => onToggle(state !== 'all')}
    />
  );
}

export function MarketsSection({ hiddenMarkets, onChange, onBrowseMarket }: MarketsSectionProps): JSX.Element {
  const t = useT();
  const venues = useVenueCatalog(true);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => marketsByGroup(venueOptions(venues ?? [])), [venues]);
  const filter = useMemo(() => marketFilter(hiddenMarkets), [hiddenMarkets]);
  const needle = searchFold(query.trim());

  return (
    <div className="setting markets-setting" data-testid="setting-markets">
      <span className="setting__hint">{t('settings.markets.hint')}</span>
      <input
        type="search"
        className="setting__text"
        placeholder={t('settings.markets.search')}
        aria-label={t('settings.markets.search')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="markets-search"
      />
      {venues === null ? (
        <span className="setting__hint" role="status">{t('settings.markets.loading')}</span>
      ) : null}
      {MARKET_GROUPS.map((group) => {
        const options = groups.get(group) ?? [];
        if (options.length === 0) return null;
        const markets = options.map((option) => option.market);
        const shown = needle === ''
          ? options
          : options.filter((option) => searchFold(option.label).includes(needle));
        if (needle !== '' && shown.length === 0) return null;
        const on = filter.isGroupHidden(group) ? 0 : markets.filter((market) => filter.isVisible(market)).length;
        const groupName = t(`settings.markets.group.${group}`);
        return (
          <details key={group} className="markets-group" open={needle !== '' || undefined} data-testid={`markets-${group}`}>
            <summary className="markets-group__summary">
              <GroupCheckbox
                group={group}
                state={groupState(filter, group, markets)}
                label={groupName}
                onToggle={(visible) => onChange({ hiddenMarkets: setGroupVisible(hiddenMarkets, group, visible) })}
              />
              <span className="markets-group__name">{groupName}</span>
              <span className="markets-group__count">
                {t('settings.markets.count', { on: String(on), total: String(markets.length) })}
              </span>
            </summary>
            <ul className="markets-group__list">
              {shown.map((option) => (
                <li key={option.market} className="markets-row">
                  <label className="markets-row__label">
                    <input
                      type="checkbox"
                      checked={filter.isVisible(option.market)}
                      data-testid={`market-${option.market}`}
                      onChange={(e) =>
                        onChange({
                          hiddenMarkets: setMarketVisible(hiddenMarkets, option.market, e.target.checked, markets),
                        })
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                  {onBrowseMarket && filter.isVisible(option.market) ? (
                    <button
                      type="button"
                      className="markets-row__browse"
                      onClick={() => onBrowseMarket(option.market)}
                      data-testid={`market-browse-${option.market}`}
                      title={t('settings.markets.browseTitle', { market: option.market })}
                    >
                      {t('settings.markets.browse')}
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
