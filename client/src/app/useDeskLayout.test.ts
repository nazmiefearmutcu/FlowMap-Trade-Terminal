import { describe, expect, it } from 'vitest';

import { layoutPreset } from './useDeskLayout';

describe('layoutPreset', () => {
  it('analysis shows the CVD pane and the volume profile, with a taller CVD pane and a narrower book', () => {
    expect(layoutPreset('analysis')).toEqual({ domRatio: 0.4, cvdHeight: 160, railVisible: true, cvd: true, profile: true });
  });

  it('orderflow keeps the rail and CVD but no profile', () => {
    expect(layoutPreset('orderflow')).toEqual({ domRatio: 0.55, cvdHeight: 104, railVisible: true, cvd: true, profile: false });
  });

  it('focus hides the rail, the CVD pane and the profile', () => {
    expect(layoutPreset('focus')).toEqual({ domRatio: 0.55, cvdHeight: 104, railVisible: false, cvd: false, profile: false });
  });
});
