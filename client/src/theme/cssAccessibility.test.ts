/**
 * Accessibility and print contracts for the owned stylesheets, checked against the
 * CSS text. jsdom does not evaluate media queries or forced colours, so these read the
 * sheets and assert that each rule sits in the block that governs it:
 *
 *   - every looping animation runs at most five seconds and stops under reduced motion (WCAG 2.2.2, 2.3.3);
 *   - selected and on states keep an outline under forced colours (WCAG 1.4.1, 1.4.11);
 *   - the print sheet re-declares every light-theme token it must print with.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => readFileSync(resolve(here, relative), 'utf8');

const appCss = read('../App.css');
const drawingsCss = read('../drawings/drawings.css');
const featuresCss = read('../ui/features.css');
const intelligenceCss = read('../ui/IntelligenceDrawer.css');
const themesCss = read('themes.css');
const shellCss = read('shell.css');
const deskCss = read('../ui/Desk.css');
const marketStripCss = read('../ui/MarketStrip.css');
const gateCss = read('../ui/ChartStartupGate.css');

/** CSS with block comments removed, so prose never satisfies or breaks a rule. */
function code(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of every top-level or nested rule whose selector list names `selector` exactly. */
function ruleBodies(css: string, selector: string): string[] {
  const bodies: string[] = [];
  for (const rule of code(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(',').map((s) => s.trim()).includes(selector)) bodies.push(rule[2]);
  }
  return bodies;
}

/** True when a forced-colors block gives `selector` a system-coloured outline. */
function forcedOutline(css: string, selector: string): boolean {
  return mediaBodies(css, '(forced-colors: active)').some((body) =>
    ruleBodies(body, selector).some((decl) => /outline:\s*2px solid Highlight/.test(decl)),
  );
}

/** The body of every `@media <query> { ... }` block, with nested braces balanced. */
export function mediaBodies(css: string, query: string): string[] {
  const text = code(css);
  const head = `@media ${query} {`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(head, from);
    if (start < 0) return bodies;
    let depth = 1;
    let i = start + head.length;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
    bodies.push(text.slice(start + head.length, i - 1));
    from = i;
  }
}

/** Every `animation` declaration in a stylesheet, as [selector, shorthand value]. */
export function animationDeclarations(css: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const rule of code(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of rule[2].matchAll(/\banimation\s*:\s*([^;]+)/g)) {
      found.push([rule[1].trim(), decl[1].trim()]);
    }
  }
  return found;
}

/** Seconds one animation shorthand runs for (duration times count); `Infinity` when it never ends. */
export function animationSeconds(value: string): number {
  if (/(?:^|\s)infinite(?=\s|$)/.test(value)) return Infinity;
  const duration = value.match(/(?:^|\s)(\d*\.?\d+)(m?s)(?=\s|$)/);
  const seconds = duration ? Number(duration[1]) * (duration[2] === 'ms' ? 0.001 : 1) : 0;
  const count = value.match(/(?:^|\s)(\d+)(?=\s|$)/);
  return seconds * (count ? Number(count[1]) : 1);
}

/** Name to value for every `--token: value;` declaration in a block of CSS text. */
function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(decl[1], decl[2].trim().replace(/\s+/g, ' '));
  }
  return map;
}

/** Light-theme colour tokens: the `paper` block of themes.css (the print source). */
function paperTokens(css: string): string[] {
  const block = css.match(/:root\[data-theme='paper'\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';
  return [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8}|rgba?\()/g)].map((m) => m[1]);
}

describe('no owned animation runs longer than five seconds (WCAG 2.2.2)', () => {
  const owned: Array<[string, string]> = [
    ['App.css', appCss],
    ['drawings/drawings.css', drawingsCss],
    ['ui/features.css', featuresCss],
    ['ui/IntelligenceDrawer.css', intelligenceCss],
    ['theme/shell.css', shellCss],
  ];

  it.each(owned)('%s has no infinite animation and none past five seconds', (_file, css) => {
    const long = animationDeclarations(css).filter(([, value]) => animationSeconds(value) > 5);
    expect(long).toEqual([]);
  });

  it('reads the durations it must measure', () => {
    expect(animationSeconds('pulse 1.6s ease-out 3')).toBeCloseTo(4.8);
    expect(animationSeconds('fm-row-in var(--t-fast) both')).toBe(0);
    expect(animationSeconds('spin 2s linear infinite')).toBe(Infinity);
    expect(animationSeconds('fade 300ms ease 2')).toBeCloseTo(0.6);
  });
});

describe('animations that were infinite stop under prefers-reduced-motion (WCAG 2.3.3)', () => {
  const reduced = mediaBodies(appCss, '(prefers-reduced-motion: reduce)').join('\n');

  it.each([
    '.status__dot',
    '.reconnect-banner__dot',
    '.livectl__dot',
    '.sympal__loadbar::after',
    '.drawer-scrim',
  ])('%s is stopped under prefers-reduced-motion', (selector) => {
    expect(reduced).toContain(selector);
  });
});

describe('selected and on states survive forced colours (WCAG 1.4.1, 1.4.11)', () => {
  const forced = mediaBodies(appCss, '(forced-colors: active)').join('\n');
  const forcedDraw = mediaBodies(drawingsCss, '(forced-colors: active)').join('\n');

  it.each(['.segrow__btn.is-on', '.tbtn.is-on', '.overlay-toggle.is-on'])(
    '%s keeps a system outline',
    (selector) => {
      expect(forced).toContain(selector);
    },
  );

  it('the switch opts out of forcing and keeps a Highlight knob', () => {
    expect(forced).toContain('.check__box');
    expect(forced).toMatch(/forced-color-adjust:\s*none/);
    expect(forced).toMatch(/\.check\.is-on \.check__box::after\s*\{[^}]*Highlight/);
  });

  it.each(['.draw-toolbar__btn.is-active', '.draw-toolbar__swatch.is-active'])(
    '%s keeps a system outline in the drawing toolbar',
    (selector) => {
      expect(forcedDraw).toContain(selector);
    },
  );

  it.each([
    '.gl-canvas:focus-visible',
    '.modeseg__btn.is-on',
    '.appearance-choice.is-on',
    '.axis-auto.is-on',
    '.panel__lock.is-on',
    '.sympal__row.is-active',
    '.sympal__vrow.is-active',
    '.sympal__venuebtn.is-on',
    '.watchlist__row.is-active',
    '.talent-badge.is-active',
  ])('%s keeps a system outline under forced colours', (selector) => {
    expect(forcedOutline(appCss, selector), selector).toBe(true);
  });

  it.each([
    ['.intel-tab.is-active', intelligenceCss],
    ['.intel-filter-toggle.is-on', intelligenceCss],
  ])('%s keeps a system outline under forced colours', (selector, css) => {
    expect(forcedOutline(css, selector), selector).toBe(true);
  });
});

describe('keyboard focus rings do not depend on box-shadow (WCAG 2.4.7)', () => {
  it.each([
    ['.gl-canvas:focus-visible', appCss],
    ['.sympal__input:focus-visible', appCss],
    ['.setting__num:focus-visible', appCss],
    ['.alerts-add__input:focus-visible', featuresCss],
    ['.draw-layer__text-input:focus-visible', drawingsCss],
  ])('%s draws a real outline', (selector, css) => {
    const bodies = ruleBodies(css, selector);
    expect(bodies.length, `${selector} has a focus-visible rule`).toBeGreaterThan(0);
    expect(bodies.some((decl) => /outline:\s*2px solid var\(--focus\)/.test(decl)), selector).toBe(true);
    expect(bodies.some((decl) => /outline:\s*none/.test(decl)), selector).toBe(false);
  });
});

describe('print sheet carries the light tokens it prints with', () => {
  const printBody = [...mediaBodies(appCss, 'print'), ...mediaBodies(themesCss, 'print')].join('\n');
  const paperBlock = themesCss.match(/:root\[data-theme='paper'\]\s*\{([\s\S]*?)\}/)?.[1] ?? '';

  it('prints every token it sets with the paper value (App.css and themes.css)', () => {
    const paper = declarations(paperBlock);
    const printed = declarations(printBody);
    expect(printed.size).toBeGreaterThan(0);
    for (const [name, value] of printed) {
      expect(paper.get(name), `--${name} in the print sheet`).toBe(value);
    }
  });

  it('finds the print token block', () => {
    expect(printBody).toMatch(/--bg:\s*#/);
  });

  it.each(paperTokens(themesCss))('re-declares --%s for print', (token) => {
    expect(printBody).toMatch(new RegExp(`--${token}:\\s*\\S`));
  });
});

/** Every `outline` declared on a `:focus-visible` rule, as [selector, value]. */
function focusVisibleOutlines(css: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const rule of code(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].includes(':focus-visible')) continue;
    for (const decl of rule[2].matchAll(/\boutline\s*:\s*([^;]+)/g)) {
      found.push([rule[1].trim(), decl[1].trim()]);
    }
  }
  return found;
}

describe('focus rings share one token (WCAG 2.4.7)', () => {
  it.each([
    ['App.css', appCss],
    ['ui/Desk.css', deskCss],
    ['ui/MarketStrip.css', marketStripCss],
    ['ui/ChartStartupGate.css', gateCss],
    ['ui/IntelligenceDrawer.css', intelligenceCss],
    ['drawings/drawings.css', drawingsCss],
  ])('%s draws every focus ring in --focus, never in the accent', (_file, css) => {
    const accentRings = focusVisibleOutlines(css).filter(([, value]) => /var\(--accent\)/.test(value));
    expect(accentRings).toEqual([]);
  });
});

describe('the reconnect banner stays reachable over the chart startup gate', () => {
  it('stacks every banner z-index above the gate z-index', () => {
    const zIndex = (body: string): number => Number(/z-index:\s*(\d+)/.exec(body)?.[1]);
    const gate = zIndex(ruleBodies(gateCss, '.chart-startup')[0] ?? '');
    const banner = ruleBodies(appCss, '.reconnect-banner').filter((body) => /z-index/.test(body));
    expect(Number.isFinite(gate)).toBe(true);
    expect(banner.length).toBeGreaterThan(0);
    for (const body of banner) expect(zIndex(body)).toBeGreaterThan(gate);
  });
});

describe('top bar zone label and off-state key rows are styled', () => {
  it('the zone abbreviation is smaller and muted beside the wall time', () => {
    const zone = ruleBodies(appCss, '.clock__zone');
    expect(zone.some((body) => /font-size:\s*var\(--fs-2xs\)/.test(body) && /color:\s*var\(--text-3\)/.test(body))).toBe(
      true,
    );
    expect(ruleBodies(appCss, '.clock__wall').some((body) => /font-size:\s*var\(--fs-md\)/.test(body))).toBe(true);
  });

  it('a bare-key row with the single-key switch off is dimmed and tagged in text', () => {
    expect(ruleBodies(appCss, '.keysheet__row.is-off .keysheet__keys').length).toBeGreaterThan(0);
    expect(ruleBodies(appCss, '.keysheet__off').length).toBeGreaterThan(0);
  });
});
