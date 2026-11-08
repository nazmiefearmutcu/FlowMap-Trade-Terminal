import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FONT_LICENSES } from './fontLicenses';

const here = dirname(fileURLToPath(import.meta.url));
const fontsCss = readFileSync(resolve(here, 'fonts.css'), 'utf8');

describe('bundled font licences', () => {
  it('covers every font family fonts.css registers', () => {
    const registered = new Set([...fontsCss.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
    expect([...registered].sort()).toEqual(FONT_LICENSES.map((f) => f.family).sort());
  });

  it.each(FONT_LICENSES)('$family ships the full OFL 1.1 text in the bundle', ({ text, license }) => {
    expect(license).toBe('SIL Open Font License 1.1');
    expect(text).toMatch(/SIL OPEN FONT LICENSE Version 1\.1/);
    expect(text).toMatch(/Copyright \d{4} The .+ Project Authors/);
    expect(text.length).toBeGreaterThan(1000);
  });
});
