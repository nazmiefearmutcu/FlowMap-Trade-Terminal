import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/** CSS with block comments removed, so prose never satisfies a rule. */
const css = readFileSync(resolve(here, 'watchlist.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('watchlist stale rows', () => {
  it('signals staleness with a colour, never an opacity fade', () => {
    // A faded row drops its text below AA on the light themes (WCAG 1.4.3).
    const staleRules = css.match(/\.watchlist__row\.is-stale\s*\{[^}]*\}/g) ?? [];
    expect(staleRules.join('\n')).not.toMatch(/opacity/);
    expect(css).toMatch(/\.watchlist__row\.is-stale \.watchlist__sym[\s\S]*?color: var\(--text-3\)/);
    expect(css).toMatch(/\.watchlist__row\.is-stale \.watchlist__px[\s\S]*?color: var\(--text-3\)/);
  });

  it('keeps a system outline on the active row under forced colours', () => {
    const forced = css.split('@media (forced-colors: active)').slice(1).join('\n');
    expect(forced).toContain('.watchlist__row.is-active');
    expect(forced).toContain('outline: 2px solid Highlight');
  });
});
