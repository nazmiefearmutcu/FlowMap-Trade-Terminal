/** Price-family key resolved from the current theme, independently of canvas bridge timing. */
import { resolveOverlayColors } from '../gl/overlays/palette';
import type { OverlayVisibility } from '../gl/overlays/frame';
import { THEMES, useTheme, type ThemeId } from '../theme';
import { t } from '../i18n';
import { useT } from '../i18n/useT';
import './ChartLegend.css';

/** Swatch shape: a line (price-family), a teal/red line pair (BBO), or a dot pair (trades). */
type SwatchKind = 'line' | 'pair' | 'dots';

export interface LegendItem {
  /** The overlay toggle that draws this item; a hidden overlay drops its key. */
  key: 'price' | 'vwap' | 'bbo' | 'bubbles';
  label: string;
  kind: SwatchKind;
  /** One color for `line`; two for `pair` / `dots`. */
  colors: readonly string[];
}

/**
 * The price-family keys for the current theme, minus any overlay that is off.
 * Shared with the PNG export so the picture lists exactly what the screen lists.
 * The palette is the same pure one the canvas bridge applies after React renders.
 */
export function legendItemsFor(theme: ThemeId, overlays?: Partial<OverlayVisibility>): LegendItem[] {
  const colors = resolveOverlayColors(THEMES[theme].canvas, THEMES[theme].chart);
  const all: LegendItem[] = [
    { key: 'price', label: t('desk.lastPrice'), kind: 'line', colors: [colors.price] },
    // VWAP and BBO are market identifiers in both languages (the same names the
    // order book and the overlay settings use), so they are not translated.
    { key: 'vwap', label: 'VWAP', kind: 'line', colors: [colors.vwap] },
    { key: 'bbo', label: 'BBO', kind: 'pair', colors: [colors.bid, colors.ask] },
    { key: 'bubbles', label: t('desk.bubbles'), kind: 'dots', colors: [colors.buy, colors.sell] },
  ];
  return all.filter((item) => overlays?.[item.key] !== false);
}

export interface ChartLegendProps {
  /** Overlay visibility from the settings; omitted means every item is drawn. */
  overlays?: Partial<OverlayVisibility>;
}

export function ChartLegend({ overlays }: ChartLegendProps = {}): JSX.Element | null {
  const { theme } = useTheme();
  // Subscribes to the locale: the item labels and the group name re-render on change.
  const localeT = useT();
  const items = legendItemsFor(theme, overlays);
  if (items.length === 0) return null;
  return (
    <div
      className="chart-legend"
      data-testid="chart-legend"
      role="img"
      aria-label={localeT('legend.ariaLabel', { items: items.map((i) => i.label.toLowerCase()).join(', ') })}
    >
      {items.map((item) => (
        <span className="chart-legend__item" key={item.label}>
          {item.kind === 'line' && (
            <span
              className="chart-legend__line"
              data-swatch="line"
              style={{ background: item.colors[0] }}
              aria-hidden="true"
            />
          )}
          {item.kind === 'pair' && (
            <span className="chart-legend__pair" data-swatch="pair" aria-hidden="true">
              <span className="chart-legend__line" style={{ background: item.colors[0] }} />
              <span className="chart-legend__line" style={{ background: item.colors[1] }} />
            </span>
          )}
          {item.kind === 'dots' && (
            <span className="chart-legend__dots" data-swatch="dots" aria-hidden="true">
              <span className="chart-legend__dot" style={{ background: item.colors[0] }} />
              <span className="chart-legend__dot" style={{ background: item.colors[1] }} />
            </span>
          )}
          <span className="chart-legend__label">{item.label}</span>
        </span>
      ))}
    </div>
  );
}
