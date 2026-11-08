/** The desk layouts: the arrangement presets the desk toolbar switches between. */
export type DeskLayout = 'orderflow' | 'analysis' | 'focus';

/** The persisted desk arrangement: the layout and the splitter sizes. */
export interface DeskPreferences {
  layout: DeskLayout;
  /** Right rail width in px. */
  railWidth: number;
  /** Share of the rail height the DOM ladder takes (0 to 1). */
  domRatio: number;
  /** CVD pane height in px. */
  cvdHeight: number;
}

/** localStorage key holding the desk arrangement as JSON. */
export const DESK_KEY = 'flowmap.desk.v1';

const LAYOUTS: readonly DeskLayout[] = ['orderflow', 'analysis', 'focus'];
const DEFAULTS: DeskPreferences = { layout: 'orderflow', railWidth: 340, domRatio: 0.55, cvdHeight: 104 };

/** A finite number clamped to [lo, hi]; anything else takes the fallback. */
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

/**
 * Read the saved arrangement. A missing, unreadable or malformed store yields the
 * defaults, and each invalid field falls back on its own.
 */
export function loadDeskPreferences(storage: Pick<Storage, 'getItem'> | null): DeskPreferences {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(DESK_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULTS };
    const saved = parsed as Partial<Record<keyof DeskPreferences, unknown>>;
    const layout = LAYOUTS.find((candidate) => candidate === saved.layout);
    return {
      layout: layout ?? DEFAULTS.layout,
      railWidth: clamp(saved.railWidth, 280, 560, DEFAULTS.railWidth),
      domRatio: clamp(saved.domRatio, 0.25, 0.75, DEFAULTS.domRatio),
      cvdHeight: clamp(saved.cvdHeight, 60, 220, DEFAULTS.cvdHeight),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist the arrangement. Blocked storage keeps it for this session only. */
export function saveDeskPreferences(storage: Pick<Storage, 'setItem'> | null, value: DeskPreferences): void {
  try {
    storage?.setItem(DESK_KEY, JSON.stringify(value));
  } catch {
    /* session preferences remain usable */
  }
}
