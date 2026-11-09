/**
 * Visible labels the top bar shows for values the server sends as English tokens.
 * The token stays the data identity (the CSS class, the test id); only the reader's
 * text is translated here.
 */

type Translate = (key: string) => string;

/**
 * The macro stress regime (`NORMAL` / `ELEVATED` / `SEVERE` / `UNKNOWN`) in the
 * active locale. `UNKNOWN` makes no claim, so it reads as the unavailable word
 * (the same text a missing macro feed shows). An unrecognised token is shown as
 * received rather than guessed at.
 */
export function stressRegimeLabel(regime: string, t: Translate): string {
  switch (regime.toUpperCase()) {
    case 'NORMAL':
      return t('stress.regime.normal');
    case 'ELEVATED':
      return t('stress.regime.elevated');
    case 'SEVERE':
      return t('stress.regime.severe');
    case 'UNKNOWN':
      return t('topbar.unavailable');
    default:
      return regime;
  }
}
