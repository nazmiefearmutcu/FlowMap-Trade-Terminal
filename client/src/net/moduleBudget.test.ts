/**
 * Size budget for the client source, so a split stays a split. It is the client
 * counterpart of the server's feed, data and NLP budget: a module has a line
 * budget and a class a length budget. A new module or class over its budget
 * fails here; split a cohesive group into a sibling module instead of raising
 * the number.
 *
 * The modules and classes that were already over budget when the budget was set
 * are listed with their size at that time. Each may shrink but never grow, and
 * its owner lowers the entry as the split lands. Growth past a listed size fails.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_LINE_BUDGET = 800;
const CLASS_LINE_BUDGET = 600;

/** Module size ceilings (lines) for modules over {@link MODULE_LINE_BUDGET} at budget time. */
const MODULE_CEILINGS: Readonly<Record<string, number>> = {
  'gl/heatmap.ts': 1295,
  'gl/normalize.ts': 882,
  'gl/renderer.ts': 1087,
  'gl/shaders/heatmap.ts': 824,
  'i18n/en.ts': 933,
  'i18n/tr.ts': 931,
  'net/connection.ts': 1252,
};

/** Class length ceilings (lines), keyed `module#Class`, for classes over {@link CLASS_LINE_BUDGET}. */
const CLASS_CEILINGS: Readonly<Record<string, number>> = {
  'gl/normalize.ts#ViewportNormalizer': 700,
  'gl/renderer.ts#Renderer': 976,
  'net/connection.ts#Connection': 919,
  'net/history.ts#HistoryLoader': 611,
};

interface SourceFile {
  /** Path relative to client/src, with forward slashes. */
  rel: string;
  lines: string[];
}

function sourceFiles(dir: string = SRC): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    const rel = relative(SRC, full).split(sep).join('/');
    out.push({ rel, lines: readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n') });
  }
  return out;
}

/** Each top-level class with its length in lines, from its header to the column-zero closing brace. */
function classLengths(file: SourceFile): { name: string; length: number }[] {
  const found: { name: string; length: number }[] = [];
  file.lines.forEach((line, start) => {
    const match = /^(?:export )?(?:abstract )?class (\w+)/.exec(line);
    if (!match) return;
    let end = start + 1;
    while (end < file.lines.length && file.lines[end] !== '}') end++;
    found.push({ name: match[1], length: end - start + 1 });
  });
  return found;
}

const FILES = sourceFiles();

describe('client source size budget', () => {
  it.each(FILES.map((f) => [f.rel, f] as const))('%s stays within its module line budget', (rel, file) => {
    const ceiling = MODULE_CEILINGS[rel] ?? MODULE_LINE_BUDGET;
    expect(file.lines.length, `${rel} has ${file.lines.length} lines; split a cohesive group into a sibling module`).toBeLessThanOrEqual(ceiling);
  });

  it.each(
    FILES.flatMap((f) => classLengths(f).map((c) => [`${f.rel}#${c.name}`, c.length] as const)),
  )('%s stays within its class length budget', (key, length) => {
    const ceiling = CLASS_CEILINGS[key] ?? CLASS_LINE_BUDGET;
    expect(length, `${key} spans ${length} lines; move a cohesive group of members into a helper`).toBeLessThanOrEqual(ceiling);
  });
});
