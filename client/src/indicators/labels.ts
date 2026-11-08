/**
 * Localised display text for the indicator registry. The registry keeps its
 * English labels as the data source and as the fallback for a key it does not
 * translate; the picker and the pane titles show these translations so a
 * Turkish session reads "Hızlı / Yavaş / Taban" instead of English words.
 */

import { t } from '../i18n';

/** Translated parameter label (`fallback` for a parameter without a translation). */
export function paramLabel(key: string, fallback: string): string {
  switch (key) {
    case 'period':
      return t('indi.param.period');
    case 'fast':
      return t('indi.param.fast');
    case 'slow':
      return t('indi.param.slow');
    case 'signal':
      return t('indi.param.signal');
    case 'mult':
      return t('indi.param.mult');
    default:
      return fallback;
  }
}

/** Translated output label such as "Basis" or "Upper" (`fallback` otherwise). */
export function outputLabel(key: string, fallback: string): string {
  switch (key) {
    case 'basis':
      return t('indi.out.basis');
    case 'upper':
      return t('indi.out.upper');
    case 'lower':
      return t('indi.out.lower');
    case 'signal':
      return t('indi.out.signal');
    case 'hist':
      return t('indi.out.hist');
    default:
      return fallback;
  }
}

/** Translated indicator name for a registry id (`fallback` for acronyms such as SMA). */
export function indicatorName(id: string, fallback: string): string {
  switch (id) {
    case 'vwap':
      return t('indi.name.vwap');
    case 'bb':
      return t('indi.name.bb');
    default:
      return fallback;
  }
}
