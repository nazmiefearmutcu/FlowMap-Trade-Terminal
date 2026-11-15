import { afterEach, describe, expect, it } from 'vitest';

import { setLocale, t } from '../i18n';
import {
  percentOfFraction,
  pctOrDash,
  priceText,
  quantityOrDash,
  sentimentLabelText,
  signedPctOrDash,
  tvlSourceText,
  usdCompact,
} from './IntelligenceDrawerFormat';

afterEach(() => {
  setLocale('en');
});

describe('usdCompact in English', () => {
  it('writes compact dollars with the dollar sign in front', () => {
    setLocale('en');
    expect(usdCompact(1.2e9)).toBe('$1.2B');
    expect(usdCompact(-3.4e6)).toBe('-$3.4M');
    expect(usdCompact(340e6)).toBe('$340M');
    expect(usdCompact(525_000)).toBe('$525K');
    expect(usdCompact(1.278e12)).toBe('$1.3T');
    expect(usdCompact(999)).toBe('$999');
  });

  it('gives a dash for a missing value', () => {
    expect(usdCompact(null)).toBe('—');
    expect(usdCompact(undefined)).toBe('—');
    expect(usdCompact(Number.NaN)).toBe('—');
  });
});

describe('usdCompact in Turkish', () => {
  it('follows the Turkish locale: decimal comma, Turkish compact units', () => {
    setLocale('tr');
    // The locale puts a no-break space (U+00A0) between the number and its unit.
    expect(usdCompact(1.2e9)).toBe('$1,2 Mr');
    expect(usdCompact(-3.4e6)).toBe('-$3,4 Mn');
    expect(usdCompact(340e6)).toBe('$340 Mn');
    expect(usdCompact(1.278e12)).toBe('$1,3 Tn');
  });

  it('still gives a dash for a missing value', () => {
    setLocale('tr');
    expect(usdCompact(null)).toBe('—');
  });
});

describe('percentages follow the locale', () => {
  it('writes percentages in English with a dot and the sign in front', () => {
    setLocale('en');
    expect(pctOrDash(8.3, 2)).toBe('8.30%');
    expect(pctOrDash(-8.3, 2)).toBe('-8.30%');
    expect(signedPctOrDash(1.5, 2)).toBe('+1.50%');
    expect(signedPctOrDash(-8.3, 2)).toBe('-8.30%');
    expect(signedPctOrDash(0, 2)).toBe('0.00%');
    expect(percentOfFraction(-0.00006549, 4)).toBe('-0.0065%');
  });

  it('writes Turkish percentages with the sign before the percent sign and a decimal comma', () => {
    setLocale('tr');
    expect(pctOrDash(8.3, 2)).toBe('%8,30');
    expect(pctOrDash(-8.3, 2)).toBe('-%8,30');
    expect(signedPctOrDash(1.5, 2)).toBe('+%1,50');
    expect(signedPctOrDash(-8.3, 2)).toBe('-%8,30');
    expect(percentOfFraction(-0.00006549, 4)).toBe('-%0,0065');
  });

  it('gives a dash for a missing percentage', () => {
    expect(pctOrDash(null, 2)).toBe('—');
    expect(signedPctOrDash(undefined, 2)).toBe('—');
  });
});

describe('prices and quantities follow the locale', () => {
  it('prints one price format everywhere: decimals suit the size, the separator follows the locale', () => {
    setLocale('en');
    expect(priceText(1741.37)).toBe('1741.37');
    setLocale('tr');
    expect(priceText(1741.37)).toBe('1741,37');
    expect(priceText(161.01)).toBe('161,01');
  });

  it('shows volumes and coin quantities with no decimals from 1000 up, grouped by the locale', () => {
    setLocale('en');
    expect(quantityOrDash(55_742_971.223)).toBe('55,742,971');
    expect(quantityOrDash(2_339_172.37)).toBe('2,339,172');
    setLocale('tr');
    expect(quantityOrDash(55_742_971.223)).toBe('55.742.971');
    expect(quantityOrDash(2_339_172.37)).toBe('2.339.172');
  });

  it('shows smaller quantities with up to three significant digits', () => {
    setLocale('en');
    expect(quantityOrDash(2.327985)).toBe('2.33');
    expect(quantityOrDash(0.1234)).toBe('0.123');
    setLocale('tr');
    expect(quantityOrDash(2.327985)).toBe('2,33');
    expect(quantityOrDash(null)).toBe('—');
  });
});

describe('source labels follow the locale', () => {
  it('translates the five Fear & Greed labels and shows any other label as given', () => {
    setLocale('tr');
    expect(sentimentLabelText(t, 'Extreme Fear')).toBe('Aşırı korku');
    expect(sentimentLabelText(t, 'Fear')).toBe('Korku');
    expect(sentimentLabelText(t, 'Neutral')).toBe('Nötr');
    expect(sentimentLabelText(t, 'Greed')).toBe('Açgözlülük');
    expect(sentimentLabelText(t, 'Extreme Greed')).toBe('Aşırı açgözlülük');
    expect(sentimentLabelText(t, 'Something New')).toBe('Something New');
    expect(sentimentLabelText(t, null)).toBe('—');
    setLocale('en');
    expect(sentimentLabelText(t, 'Extreme Fear')).toBe('Extreme Fear');
  });

  it('translates the TVL source tokens and shows any other as given', () => {
    setLocale('tr');
    expect(tvlSourceText(t, 'chain')).toBe('zincir');
    expect(tvlSourceText(t, 'protocol')).toBe('protokol');
    expect(tvlSourceText(t, 'other')).toBe('other');
    setLocale('en');
    expect(tvlSourceText(t, 'chain')).toBe('chain');
    expect(tvlSourceText(t, 'protocol')).toBe('protocol');
  });
});
