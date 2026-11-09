import { describe, expect, it } from 'vitest';

import { chartHelpKey } from './workspaceScope';

describe('chartHelpKey', () => {
  it('names the bare-key sentence only while single-key shortcuts are on', () => {
    expect(chartHelpKey(true)).toBe('chart.ariaHelp');
    expect(chartHelpKey(false)).toBe('chart.ariaHelpNoKey');
  });
});
