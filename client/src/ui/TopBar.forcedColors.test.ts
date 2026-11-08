import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, relative), 'utf8');

/** CSS with block comments removed, so prose never satisfies a rule. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The text of every `@media (forced-colors: active)` block, joined. */
function forcedText(css: string): string {
  return code(css).split('@media (forced-colors: active)').slice(1).join('\n');
}

/**
 * A selected state keeps a system outline under Windows High Contrast. Forced
 * colours drop the background fill that marks it, so the outline is the only cue
 * left (WCAG 1.4.1, 1.4.11). jsdom does not evaluate forced colours, so this reads
 * the sheets and checks that the selector's rule sits in the forced-colors block.
 */
function expectForcedOutline(css: string, selector: string): void {
  const forced = forcedText(css);
  expect(forced).toContain(selector);
  expect(forced).toContain('outline: 2px solid Highlight');
}

describe('selected states survive forced colours', () => {
  it('keeps the live/replay mode outline in the top bar', () => {
    expectForcedOutline(read('TopBar.css'), '.modeseg__btn.is-on');
  });

  it('keeps the active watchlist row outline', () => {
    expectForcedOutline(read('../watchlist/watchlist.css'), '.watchlist__row.is-active');
  });
});
