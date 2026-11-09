import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_TEXT_SIZE } from '../textLayer';

const DIR = join(process.cwd(), 'src/gl/overlays');

describe('chart badge sizes', () => {
  it('keeps every literal badge size at the type floor, or behind an explicit size budget', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      readFileSync(join(DIR, file), 'utf8').split(/\r?\n/).forEach((line, index) => {
        for (const match of line.matchAll(/size: (\d+)/g)) {
          if (Number(match[1]) < DEFAULT_TEXT_SIZE && !line.includes('size-budget:')) {
            offenders.push(`${file}:${index + 1}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
