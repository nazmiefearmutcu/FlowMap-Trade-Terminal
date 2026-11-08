/**
 * The persisted colormaps: one catalog powers validation and picker options, in
 * Settings order. The default is 'theme' (gl/lut.ts DEFAULT_COLORMAP), which follows
 * the active theme's ground and ink; the rest are fixed ramps.
 *
 * `nameKey` is the i18n key of the option's name when the name is an English word
 * (Theme, Flow, Classic, Ice, Mono). The scientific names (Inferno, Viridis, Cividis)
 * are the same in every language, so they carry `nameKey: null` and show `label`.
 * The key is the one the Settings grid renders: `colormap.<id>`, or `palette.theme`.
 */
export const COLORMAP_CATALOG = [
 { id: 'theme', label: 'Theme', nameKey: 'palette.theme', hint: 'identity' },
 { id: 'flow', label: 'Flow', nameKey: 'palette.name.flow', hint: 'detail' },
 { id: 'inferno', label: 'Inferno', nameKey: null, hint: 'warm' },
 { id: 'classic', label: 'Classic', nameKey: 'palette.name.classic', hint: 'thermal' },
 { id: 'ice', label: 'Ice', nameKey: 'palette.name.ice', hint: 'cool' },
 { id: 'viridis', label: 'Viridis', nameKey: null, hint: 'green' },
 { id: 'cividis', label: 'Cividis', nameKey: null, hint: 'blueYellow' },
 { id: 'mono', label: 'Mono', nameKey: 'palette.name.mono', hint: 'mono' },
] as const;
export type Colormap = typeof COLORMAP_CATALOG[number]['id'];

export function isColormap(value: unknown): value is Colormap {
  return COLORMAP_CATALOG.some(c => c.id === value);
}
