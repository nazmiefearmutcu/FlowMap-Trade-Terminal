/**
 * The market map: a full-window screen of tiles, one per stock or coin. A tile's
 * area is its market value and its colour is its price change over the period.
 * A tile with a chart opens that chart and closes the map.
 *
 * It is a modal dialog with the same contract as ShortcutsOverlay: focus moves in
 * on open and back to the opener on close, Tab is trapped, and Escape closes it
 * while it is the topmost overlay. It mounts only while open, so its data
 * requests stop when it closes.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';

import { exchangeZoneFor, formatClock, formatPrice, useTimeZone } from '../../i18n/format';
import { useT, type TFn } from '../../i18n/useT';
import { useMarketFilter } from '../marketFilter';
import { isTopOverlay, pushOverlay } from '../overlayStack';
import { fetchMarketMap, type MapItem, type MapMarket, type MarketMapData } from './marketMapApi';
import { tileCardPosition, pointerCardPosition, type Point } from './marketMapCard';
import {
  CLAMP_PERCENT,
  DEFAULT_PERIOD,
  PERIODS,
  changeLevel,
  fillShare,
  formatChange,
  formatCompact,
  labelFor,
  tileInk,
  tileTone,
  toGroups,
} from './marketMapModel';
import { layoutTreemap, type Rect, type TreemapGroupLayout } from './treemap';
import './MarketMap.css';

export interface MarketMapProps {
  open: boolean;
  onClose: () => void;
  /** Opens a symbol's chart the same way the symbol search does. */
  onOpenChart: (market: string, symbol: string) => void;
}

/** How often the visible tab is refetched while the map is open. */
const REFRESH_MS = 60_000;
/** Height of a sector's name strip, when the map has more than one sector. */
const GROUP_HEADER_PX = 18;
/** Stepped colours shown in the legend, from most negative to most positive. */
const LEGEND_LEVELS = [-1, -0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1];
const MARKETS: readonly MapMarket[] = ['us', 'crypto'];

interface MarketState {
  data: MarketMapData | null;
  /** The reason the last request failed, or null. Shown only while there is no data. */
  error: string | null;
}

const EMPTY_STATE: MarketState = { data: null, error: null };

/** The tile under the pointer or keyboard focus. `pointer` is null for keyboard focus. */
interface Hover {
  symbol: string;
  pointer: Point | null;
}

/** A tile's rectangle in body coordinates, rounded to whole pixels on both edges. */
function boxStyle(rect: Rect): CSSProperties {
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  return {
    left,
    top,
    width: Math.round(rect.x + rect.w) - left,
    height: Math.round(rect.y + rect.h) - top,
  };
}

/** A tile's box and the share of colour its fill mixes in, which the stylesheet reads. */
function tileStyle(rect: Rect, strength: number): CSSProperties {
  return { ...boxStyle(rect), '--fill-share': fillShare(strength) } as CSSProperties;
}

/** Decimals for a price: two from one unit up, four below, so a cheap coin still shows movement. */
function priceDecimals(price: number): number {
  return Math.abs(price) >= 1 ? 2 : 4;
}

/** A signed whole percent for a legend end: `+3%` or `−3%`. */
function signedPercent(value: number): string {
  return value < 0 ? `−${Math.abs(value)}%` : `+${value}%`;
}

interface DetailRow {
  label: string;
  value: string;
}

/** The facts a tile shows about its instrument, in reading order. */
function detailRows(item: MapItem, period: string, t: TFn): DetailRow[] {
  const change = item.change[period];
  const rows: DetailRow[] = [
    { label: t('marketMap.detail.price'), value: formatPrice(item.price, priceDecimals(item.price)) },
    {
      label: `${t('marketMap.detail.change')} (${t(`marketMap.period.${period}`)})`,
      value: change === undefined ? '—' : formatChange(change),
    },
    { label: t('marketMap.detail.marketCap'), value: formatCompact(item.marketCap) },
  ];
  if (item.volume !== null) rows.push({ label: t('marketMap.detail.volume'), value: formatCompact(item.volume) });
  return rows;
}

/** The elements Tab can reach inside `root`, in document order. */
function tabbableWithin(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]')].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

export function MarketMap({ open, onClose, onOpenChart }: MarketMapProps): JSX.Element | null {
  if (!open) return null;
  return <MarketMapDialog onClose={onClose} onOpenChart={onOpenChart} />;
}

function MarketMapDialog({ onClose, onOpenChart }: Omit<MarketMapProps, 'open'>): JSX.Element {
  const t = useT();
  const zonePref = useTimeZone();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<MapMarket, HTMLButtonElement | null>>>({});

  // A tab whose markets are switched off in Settings → Markets is not offered.
  const filter = useMarketFilter();
  const tabs = useMemo(
    () => MARKETS.filter((m) => (m === 'us' ? filter.isVisible('equity') : !filter.isGroupHidden('crypto'))),
    [filter],
  );
  const [chosenMarket, setMarket] = useState<MapMarket>('us');
  const market: MapMarket = tabs.includes(chosenMarket) ? chosenMarket : (tabs[0] ?? chosenMarket);
  const allOff = tabs.length === 0;
  const [periods, setPeriods] = useState<Record<MapMarket, string>>(DEFAULT_PERIOD);
  // Each tab keeps its own last data, so switching back shows it at once.
  const [states, setStates] = useState<Record<MapMarket, MarketState>>({ us: EMPTY_STATE, crypto: EMPTY_STATE });
  const [reloadKey, setReloadKey] = useState(0);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hovered, setHovered] = useState<Hover | null>(null);

  const period = periods[market];
  const state = states[market];
  const data = state.data;

  // Overlay stack: Escape closes this overlay only while it is the topmost one.
  useEffect(() => pushOverlay('marketMap'), []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTopOverlay('marketMap')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Modal focus: remember the opener, move focus in, and give it back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  // Fetch the visible tab when it changes and on each refresh. Changing the tab or
  // closing aborts the request in flight; an aborted request writes nothing.
  useEffect(() => {
    if (allOff) return undefined;
    const controller = new AbortController();
    setStates((prev) =>
      prev[market].error === null ? prev : { ...prev, [market]: { ...prev[market], error: null } },
    );
    fetchMarketMap(market, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setStates((prev) => ({ ...prev, [market]: { data: next, error: null } }));
      },
      (err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setStates((prev) => ({ ...prev, [market]: { ...prev[market], error: messageOf(err) } }));
      },
    );
    return () => controller.abort();
  }, [market, reloadKey, allOff]);

  useEffect(() => {
    const id = window.setInterval(() => setReloadKey((k) => k + 1), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  // The body's size drives the layout. Measured once, then followed as the window changes.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const apply = (w: number, h: number): void => {
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const rect = el.getBoundingClientRect();
    apply(Math.floor(rect.width), Math.floor(rect.height));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(Math.floor(box.width), Math.floor(box.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layouts = useMemo<TreemapGroupLayout[]>(() => {
    if (!data || size.w <= 0 || size.h <= 0) return [];
    const groups = toGroups(data.items);
    return layoutTreemap(groups, size.w, size.h, { headerHeight: groups.length > 1 ? GROUP_HEADER_PX : 0 });
  }, [data, size]);

  const itemsBySymbol = useMemo(() => new Map((data?.items ?? []).map((item) => [item.symbol, item])), [data]);
  const rectsBySymbol = useMemo(() => {
    const rects = new Map<string, Rect>();
    for (const group of layouts) for (const tile of group.tiles) rects.set(tile.id, tile.rect);
    return rects;
  }, [layouts]);

  const selectMarket = (next: MapMarket): void => {
    if (next !== market) setMarket(next);
  };

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tabs[(tabs.indexOf(market) + 1) % tabs.length] ?? market;
    selectMarket(next);
    tabRefs.current[next]?.focus();
  };

  // Tab and Shift+Tab stay inside the dialog while it is open, on the elements
  // Tab can actually reach (the inactive tab is skipped).
  const onTrapKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = tabbableWithin(panel);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  /** The pointer's position inside the body, which the detail card is placed from. */
  const bodyPoint = (e: MouseEvent<HTMLElement>): Point => {
    const box = bodyRef.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  const groupLabel = (name: string): string => (name === 'Other' ? t('marketMap.group.other') : name);
  const clamp = CLAMP_PERCENT[period];
  const hoveredItem = hovered === null ? undefined : itemsBySymbol.get(hovered.symbol);
  const hoveredRect = hovered === null ? undefined : rectsBySymbol.get(hovered.symbol);
  const showStale = data !== null && data.stale;

  let body: JSX.Element;
  if (allOff) {
    body = <p className="market-map__state" role="status" data-testid="market-map-all-off">{t('marketMap.allOff')}</p>;
  } else if (data === null && state.error !== null) {
    body = (
      <div className="market-map__state" role="alert">
        <p>{t('marketMap.error')}</p>
        <p className="market-map__reason">{state.error}</p>
        <button type="button" className="market-map__retry" onClick={() => setReloadKey((k) => k + 1)}>
          {t('marketMap.retry')}
        </button>
      </div>
    );
  } else if (data === null) {
    body = <p className="market-map__state" role="status">{t('marketMap.loading')}</p>;
  } else {
    body = (
      <>
        {layouts.map((group) => (
          <div key={group.id}>
            {group.header.h > 0 && (
              <div className="market-map__group" style={boxStyle(group.header)}>
                {groupLabel(group.id)}
              </div>
            )}
            {group.tiles.map((tile) => {
              const item = itemsBySymbol.get(tile.id);
              if (!item) return null;
              const change = item.change[period];
              const tone = tileTone(changeLevel(change, period));
              const rows = detailRows(item, period, t);
              const facts = rows.map((r) => `${r.label} ${r.value}`).join(', ');
              // A tile whose chart market is switched off opens nothing.
              const chart = item.chart !== null && filter.isVisible(item.chart.market) ? item.chart : null;
              const noChart = chart === null ? `, ${t('marketMap.noChart')}` : '';
              const label = `${item.name} (${item.symbol}), ${facts}${noChart}`;
              const tileLabel = labelFor(tile.rect);
              const text = tileLabel === 'none' ? null : (
                <>
                  <span className="market-map__symbol">{item.symbol}</span>
                  {tileLabel === 'symbol+change' && change !== undefined && (
                    <span className="market-map__change">{formatChange(change)}</span>
                  )}
                </>
              );
              const common = {
                className: 'market-map__tile',
                'data-testid': 'market-map-tile',
                'data-side': tone.side,
                'data-ink': tileInk(tone.strength),
                style: tileStyle(tile.rect, tone.strength),
                'aria-label': label,
                onMouseEnter: (e: MouseEvent<HTMLElement>) => setHovered({ symbol: item.symbol, pointer: bodyPoint(e) }),
                onMouseMove: (e: MouseEvent<HTMLElement>) => setHovered({ symbol: item.symbol, pointer: bodyPoint(e) }),
                onMouseLeave: () => setHovered((h) => (h?.symbol === item.symbol ? null : h)),
                onFocus: () => setHovered((h) => (h?.symbol === item.symbol ? h : { symbol: item.symbol, pointer: null })),
                onBlur: () => setHovered((h) => (h?.symbol === item.symbol ? null : h)),
              };
              if (chart === null) {
                return (
                  <div key={tile.id} role="img" {...common}>
                    {text}
                  </div>
                );
              }
              return (
                <button
                  key={tile.id}
                  type="button"
                  {...common}
                  onClick={() => {
                    onOpenChart(chart.market, chart.symbol);
                    onClose();
                  }}
                >
                  {text}
                </button>
              );
            })}
          </div>
        ))}
        {hoveredItem && hovered && (hovered.pointer !== null || hoveredRect !== undefined) && (
          <div
            className="market-map__card"
            aria-hidden="true"
            style={
              hovered.pointer !== null
                ? pointerCardPosition(hovered.pointer, size)
                : tileCardPosition(hoveredRect as Rect, size)
            }
          >
            <div className="market-map__card-name">{hoveredItem.name}</div>
            <div className="market-map__card-symbol">{hoveredItem.symbol}</div>
            {detailRows(hoveredItem, period, t).map((row) => (
              <div key={row.label} className="market-map__card-row">
                <span>{row.label}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  return createPortal(
    <div
      ref={panelRef}
      className="market-map"
      role="dialog"
      aria-modal="true"
      aria-labelledby="market-map-title"
      data-testid="market-map"
      onKeyDown={onTrapKeyDown}
    >
      <header className="market-map__header">
        <div className="market-map__row">
          <h2 id="market-map-title" className="market-map__title">{t('marketMap.title')}</h2>
          <div className="market-map__tabs" role="tablist" aria-label={t('marketMap.title')}>
            {tabs.map((m) => (
              <button
                key={m}
                ref={(el) => {
                  tabRefs.current[m] = el;
                }}
                type="button"
                role="tab"
                id={`market-map-tab-${m}`}
                data-testid={`market-map-tab-${m}`}
                aria-selected={market === m}
                aria-controls="market-map-body"
                tabIndex={market === m ? 0 : -1}
                className={`market-map__tab${market === m ? ' is-active' : ''}`}
                onClick={() => selectMarket(m)}
                onKeyDown={onTabKeyDown}
              >
                {t(`marketMap.tab.${m}`)}
              </button>
            ))}
          </div>
          {market === 'crypto' && (
            <div className="market-map__periods" role="group" aria-label={t('marketMap.periodLabel')}>
              {PERIODS.crypto.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={period === p}
                  className={`market-map__period${period === p ? ' is-active' : ''}`}
                  onClick={() => setPeriods((prev) => ({ ...prev, [market]: p }))}
                >
                  {t(`marketMap.period.${p}`)}
                </button>
              ))}
            </div>
          )}
          <button
            ref={closeRef}
            type="button"
            className="market-map__close"
            onClick={onClose}
            data-testid="market-map-close"
          >
            {t('marketMap.close')}
          </button>
        </div>
        <div className="market-map__row market-map__meta">
          <div className="market-map__legend" aria-hidden="true">
            <span>{clamp === undefined ? '' : signedPercent(-clamp)}</span>
            <span className="market-map__swatches">
              {LEGEND_LEVELS.map((level) => {
                const tone = tileTone(level);
                return (
                  <span
                    key={level}
                    className="market-map__swatch"
                    data-side={tone.side}
                    style={{ '--fill-share': fillShare(tone.strength) } as CSSProperties}
                  />
                );
              })}
            </span>
            <span>{clamp === undefined ? '' : signedPercent(clamp)}</span>
          </div>
          {data && (
            <span className="market-map__asof">
              {t('marketMap.asOf', {
                source: data.source,
                time: formatClock(data.asOf, zonePref, exchangeZoneFor(market === 'us' ? 'equity' : 'crypto')),
              })}
            </span>
          )}
          <span className="market-map__size-note">{t('marketMap.sizeNote')}</span>
        </div>
        {showStale && (
          <p className="market-map__notice" role="status">{t('marketMap.stale')}</p>
        )}
      </header>
      <div
        id="market-map-body"
        ref={bodyRef}
        className="market-map__body"
        role="tabpanel"
        aria-labelledby={`market-map-tab-${market}`}
      >
        {body}
      </div>
    </div>,
    document.body,
  );
}
