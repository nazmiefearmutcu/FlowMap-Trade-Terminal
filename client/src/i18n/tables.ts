/**
 * The string tables the lookup reads: the base tables plus the feature tables that live
 * beside them.
 *
 * en.ts and tr.ts are at their size ceiling (net/moduleBudget.test.ts). A new surface
 * therefore brings its strings in its own module and is merged here; a feature table never
 * redefines a base key (tables.test.ts).
 */

import { en as baseEn } from './en';
import { optionChainEn, optionChainTr } from './optionChainText';
import { realBookEn, realBookTr } from './realBookText';
import { tr as baseTr } from './tr';
import { eurexEn, eurexTr } from './eurexText';

/** English: the source of truth for every key. */
export const en: Record<string, string> = { ...baseEn, ...optionChainEn, ...realBookEn, ...eurexEn };

/** Turkish: may omit a key (the lookup falls back to English). */
export const tr: Record<string, string> = { ...baseTr, ...optionChainTr, ...realBookTr, ...eurexTr };
