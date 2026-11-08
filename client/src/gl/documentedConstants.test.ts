import { describe, expect, it } from 'vitest';

import { DEFAULT_DISPLAY_GAMMA, TRANSFER_LOW_SPAN } from './heatmap';
import { HEATMAP_FRAG } from './shaders/heatmap';

// Comments that quote a constant must match the value the code uses.
describe('documented heatmap constants', () => {
  it('the shader comment quotes the exported low-span share', () => {
    expect(TRANSFER_LOW_SPAN).toBe(0.85);
    expect(HEATMAP_FRAG).toContain(`(TRANSFER_LOW_SPAN, ${TRANSFER_LOW_SPAN})`);
  });

  it('the display gamma default is the documented 0.653', () => {
    expect(DEFAULT_DISPLAY_GAMMA).toBe(0.653);
  });
});
