/**
 * Controls the indicator picker rows are built from: the parameter text and the
 * per-output colour swatch. Pure presentation over the indicator store's values.
 */

import { formatNumber } from '../i18n/format';
import { themeSwatchHex } from '../indicators/palette';
import { useTheme } from '../theme/useTheme';
import { fallbackSeriesColor } from './IndicatorOverlayCanvas';

interface SeriesColorInputProps {
  testId: string;
  ariaLabel: string;
  /** The user's override, or null for the theme colour. */
  override: string | null;
  /** The series colour token the canvas paints this output with. */
  colorVar: string;
  onColor: (color: string) => void;
}

/**
 * A parameter value as list text: the UI locale's decimal separator (Turkish
 * reads "2,5"), with no digit grouping so a period of 500 stays "500".
 */
export function paramText(value: number): string {
  return formatNumber(value, { useGrouping: false, maximumFractionDigits: 2 });
}

/**
 * The colour swatch of one output. With no override it shows the colour the
 * line is actually drawn in (the theme's token), not a placeholder black. The
 * theme hook re-runs the read when the theme switches while the picker is open.
 */
export function SeriesColorInput({ testId, ariaLabel, override, colorVar, onColor }: SeriesColorInputProps): JSX.Element {
  useTheme();
  return (
    <input
      type="color"
      data-testid={testId}
      aria-label={ariaLabel}
      value={override ?? themeSwatchHex(colorVar, fallbackSeriesColor(colorVar))}
      onChange={(e) => onColor(e.target.value)}
    />
  );
}
