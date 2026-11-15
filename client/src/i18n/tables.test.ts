import { describe, expect, it } from 'vitest';

import { en as baseEn } from './en';
import { tFor } from './index';
import { optionChainEn, optionChainTr } from './optionChainText';
import { realBookEn, realBookTr } from './realBookText';
import { en, tr } from './tables';
import { tr as baseTr } from './tr';
import { eurexEn, eurexTr } from './eurexText';

/** Every feature table merged by tables.ts, as [English, Turkish]. */
const FEATURES: ReadonlyArray<readonly [Record<string, string>, Record<string, string>]> = [
  [optionChainEn, optionChainTr],
  [realBookEn, realBookTr],
  [eurexEn, eurexTr],
];

describe('merged string tables', () => {
  it('a feature table never redefines a base key', () => {
    for (const [featureEn, featureTr] of FEATURES) {
      expect(Object.keys(featureEn).filter((key) => baseEn[key] !== undefined)).toEqual([]);
      expect(Object.keys(featureTr).filter((key) => baseTr[key] !== undefined)).toEqual([]);
    }
  });

  it('carries every base key and every feature key', () => {
    const featureKeys = (pick: 0 | 1): number => FEATURES.reduce((sum, pair) => sum + Object.keys(pair[pick]).length, 0);
    expect(Object.keys(en).length).toBe(Object.keys(baseEn).length + featureKeys(0));
    expect(Object.keys(tr).length).toBe(Object.keys(baseTr).length + featureKeys(1));
    expect(en['topbar.rail']).toBe(baseEn['topbar.rail']);
  });

  it('translates every feature key into Turkish', () => {
    for (const [featureEn, featureTr] of FEATURES) {
      expect(Object.keys(featureEn).filter((key) => featureTr[key] === undefined)).toEqual([]);
      expect(Object.keys(featureTr).filter((key) => featureEn[key] === undefined)).toEqual([]);
    }
  });

  it('serves a feature key through the lookup in both locales', () => {
    expect(tFor('en', 'optionChain.title')).toBe('Option chain');
    expect(tFor('tr', 'optionChain.title')).toBe('Opsiyon zinciri');
    expect(tFor('en', 'optionChain.meta', { count: 1, time: '10:00:00' })).toBe('1 strike · read at 10:00:00');
    expect(tFor('en', 'optionChain.meta', { count: 82, time: '10:00:00' })).toBe('82 strikes · read at 10:00:00');
  });
});
