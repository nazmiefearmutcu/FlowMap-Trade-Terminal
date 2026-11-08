import { describe, expect, it } from 'vitest';

import { t } from '../i18n';
import { indicatorName, outputLabel, paramLabel } from './labels';

describe('indicator display labels (i18n)', () => {
  it('translates known parameter and output keys through the i18n table', () => {
    expect(paramLabel('fast', 'Fast')).toBe(t('indi.param.fast'));
    expect(paramLabel('slow', 'Slow')).toBe(t('indi.param.slow'));
    expect(paramLabel('period', 'Period')).toBe(t('indi.param.period'));
    expect(paramLabel('signal', 'Signal')).toBe(t('indi.param.signal'));
    expect(paramLabel('mult', 'StdDev')).toBe(t('indi.param.mult'));
    expect(outputLabel('basis', 'Basis')).toBe(t('indi.out.basis'));
    expect(outputLabel('upper', 'Upper')).toBe(t('indi.out.upper'));
    expect(outputLabel('lower', 'Lower')).toBe(t('indi.out.lower'));
    expect(outputLabel('hist', 'Histogram')).toBe(t('indi.out.hist'));
    expect(indicatorName('vwap', 'VWAP (since added)')).toBe(t('indi.name.vwap'));
    expect(indicatorName('bb', 'Bollinger Bands')).toBe(t('indi.name.bb'));
  });

  it('keeps the registry label for acronyms and unknown keys', () => {
    expect(indicatorName('sma', 'SMA')).toBe('SMA');
    expect(outputLabel('macd', 'MACD')).toBe('MACD');
    expect(paramLabel('zeta', 'Zeta')).toBe('Zeta');
  });
});
