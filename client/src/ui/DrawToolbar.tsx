/**
 * DrawToolbar — the vertical drawing-tools panel.
 *
 * Contents: the 6 tools (select + trendline / h-line / h-ray / rect / fib /
 * text) as icon buttons (inline SVG — zero icon deps), color swatches (the
 * drawing palette; theme-safe fixed hues are the ALLOWED hardcodes — the
 * chrome around them is all CSS vars), a stroke-width stepper, undo / redo,
 * and clear-all (window.confirm-guarded). A swatch sets the style of NEW
 * drawings, and recolors the SELECTED drawing immediately when one exists.
 *
 * KEYBOARD: the toolbar is a WAI-ARIA toolbar with roving focus. Tab reaches
 * ONE button (the last one focused, or Select); the arrow keys move between the
 * enabled buttons, and Home / End jump to the first and last.
 *
 * VISIBILITY: the panel mounts hidden; `D` toggles it via the module-level
 * {@link toggleDrawToolbar} export (drawings/store.ts). The `D` listener is
 * SELF-CONTAINED here (bare key, editable/dialog guarded via the shared
 * input/keys classifier, and off when the user has switched single-key
 * shortcuts off in input/shortcutPrefs) — App must NOT also bind `D` in keys.ts
 * or the toggle would fire twice. If App later prefers central routing, delete
 * this component's effect and register the key with `toggleDrawToolbar()` as the
 * action.
 *
 * Placement: render inside the chart's position:relative stage viewport; the
 * panel pins itself to the left edge (drawings.css `.draw-toolbar`).
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import { classifyTarget } from '../input/keys';
import { isSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import type { DrawingTool } from '../drawings/types';
import { useT } from '../i18n/useT';
import { DRAWING_INK_DEFAULT, DRAWING_INK_SWATCHES } from '../theme/drawInks';
import '../drawings/drawings.css';

/** Stroke-width choices (CSS px) the stepper cycles through. */
const WIDTHS: readonly number[] = [1, 2, 4];

/**
 * The i18n name of each swatch ink, so a screen reader says "Blue", not a hex code.
 * An ink missing here falls back to its hex text.
 */
const INK_NAME_KEYS: Readonly<Record<string, string>> = {
  [DRAWING_INK_DEFAULT]: 'drawToolbar.ink.teal',
  '#3F7FD1': 'drawToolbar.ink.blue',
  '#8A5CD6': 'drawToolbar.ink.violet',
  '#4A8F3A': 'drawToolbar.ink.green',
  '#B5651D': 'drawToolbar.ink.amber',
  '#6B7280': 'drawToolbar.ink.grey',
};

/** Order the buttons render in; `select` is the null tool (select mode). Labels are i18n keys. */
const TOOLS: readonly { tool: DrawingTool | 'select'; labelKey: string; icon: JSX.Element }[] = [
  { tool: 'select', labelKey: 'drawToolbar.select', icon: <path d="M4 2l8 7-4 .5L6.5 14z" /> },
  {
    tool: 'trendline',
    labelKey: 'drawToolbar.trendline',
    icon: (
      <>
        <path d="M3 13L13 3" />
        <circle cx="3" cy="13" r="1.4" className="fill" />
        <circle cx="13" cy="3" r="1.4" className="fill" />
      </>
    ),
  },
  { tool: 'hline', labelKey: 'drawToolbar.hline', icon: <path d="M2 8h12M8 5.5v5" /> },
  { tool: 'hray', labelKey: 'drawToolbar.hray', icon: <path d="M4 8h10M4 5.5v5" /> },
  { tool: 'rect', labelKey: 'drawToolbar.rect', icon: <rect x="3" y="4" width="10" height="8" /> },
  {
    tool: 'fib',
    labelKey: 'drawToolbar.fib',
    icon: (
      <>
        <path d="M2 3.5h12" />
        <path d="M2 6.5h12" opacity=".6" />
        <path d="M2 9.5h12" opacity=".6" />
        <path d="M2 12.5h12" />
      </>
    ),
  },
  {
    tool: 'text',
    labelKey: 'drawToolbar.text',
    icon: <path d="M3 4h10M8 4v9M6 13h4" />,
  },
];

/** Keys that move the roving focus (vertical toolbar: Up/Down; Left/Right also accepted). */
const NAV_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

interface DrawToolbarProps {
  /**
   * Persistence scope label for the clear-all confirm (defaults to the
   * store's loaded scope).
   */
  symbol?: string;
}

export function DrawToolbar({ symbol }: DrawToolbarProps): JSX.Element | null {
  const t = useT();
  const visible = useDrawingsStore((s) => s.toolbarVisible);
  const tool = useDrawingsStore((s) => s.tool);
  const defaultStyle = useDrawingsStore((s) => s.defaultStyle);
  const itemCount = useDrawingsStore((s) => s.items.length);
  const canUndo = useDrawingsStore((s) => s.undoStack.length > 0);
  const canRedo = useDrawingsStore((s) => s.redoStack.length > 0);

  // Roving tabindex: `stopKey` names the one button in the Tab order. It follows
  // focus, and falls back to Select when the remembered button is disabled.
  const [focusKey, setFocusKey] = useState<string>('select');
  const rootRef = useRef<HTMLDivElement>(null);
  const isDisabled = (key: string): boolean =>
    (key === 'undo' && !canUndo) || (key === 'redo' && !canRedo) || (key === 'clear' && itemCount === 0);
  const stopKey = isDisabled(focusKey) ? 'select' : focusKey;

  // `D` toggles the panel. Bare key only, never while typing / in a dialog, and
  // not at all when the user has switched single-key shortcuts off — the same
  // guards the app's global router applies.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'd' && e.key !== 'D') return;
      // A held key auto-repeats; one press toggles the panel once.
      if (e.repeat) return;
      if (!isSingleKeyShortcutsEnabled()) return;
      const target = classifyTarget(e.target);
      if (target.editable || target.dialog) return;
      e.preventDefault();
      toggleDrawToolbar();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!visible) return null;

  const st = useDrawingsStore.getState();
  const scope = symbol ?? (st.symbol !== null ? st.symbol : t('drawToolbar.thisChart'));

  /** Roving focus: arrows step through the enabled buttons, Home/End jump to the ends. */
  const onToolbarKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!NAV_KEYS.has(e.key)) return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(e.target as HTMLButtonElement);
    const last = items.length - 1;
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = at < 0 || at >= last ? 0 : at + 1;
    else next = at <= 0 ? last : at - 1;
    e.preventDefault();
    items[next].focus();
  };

  /** The props every button shares: the roving stop and the focus bookkeeping. */
  const rove = (key: string) => ({
    tabIndex: stopKey === key ? 0 : -1,
    onFocus: () => setFocusKey(key),
  });

  return (
    <div
      ref={rootRef}
      className="draw-toolbar"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t('drawToolbar.aria')}
      data-testid="draw-toolbar"
      onKeyDown={onToolbarKeyDown}
    >
      {TOOLS.map(({ tool: id, labelKey, icon }) => {
        const label = t(labelKey);
        const pressed = id === 'select' ? tool === null : tool === id;
        return (
          <button
            key={id}
            type="button"
            className={`draw-toolbar__btn${pressed ? ' is-active' : ''}`}
            title={label}
            aria-label={label}
            aria-pressed={pressed}
            {...rove(id)}
            onClick={() => st.armTool(id === 'select' ? null : id)}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              {icon}
            </svg>
          </button>
        );
      })}

      <div className="draw-toolbar__sep" />

      {DRAWING_INK_SWATCHES.map((color) => {
        const nameKey = INK_NAME_KEYS[color];
        const name = nameKey === undefined ? color : t(nameKey);
        return (
          <button
            key={color}
            type="button"
            className={`draw-toolbar__swatch${defaultStyle.color === color ? ' is-active' : ''}`}
            style={{ background: color }}
            title={t('drawToolbar.color', { color: name })}
            aria-label={t('drawToolbar.colorAria', { color: name })}
            aria-pressed={defaultStyle.color === color}
            {...rove(color)}
            onClick={() => st.setDefaultStyle({ color })}
          />
        );
      })}

      <div className="draw-toolbar__sep" />

      <button
        type="button"
        className="draw-toolbar__btn draw-toolbar__btn--wide"
        title={t('drawToolbar.width', { width: defaultStyle.width })}
        aria-label={t('drawToolbar.widthAria')}
        {...rove('width')}
        onClick={() => {
          const i = WIDTHS.indexOf(defaultStyle.width);
          st.setDefaultStyle({ width: WIDTHS[(i + 1) % WIDTHS.length] });
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 8h12" style={{ strokeWidth: defaultStyle.width }} />
        </svg>
      </button>

      <div className="draw-toolbar__sep" />

      <button
        type="button"
        className="draw-toolbar__btn"
        title={t('drawToolbar.undo')}
        aria-label={t('drawToolbar.undoAria')}
        disabled={!canUndo}
        {...rove('undo')}
        onClick={() => st.undo()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M6 3L2.5 6.5 6 10M3 6.5h6a4 4 0 010 8H6" />
        </svg>
      </button>
      <button
        type="button"
        className="draw-toolbar__btn"
        title={t('drawToolbar.redo')}
        aria-label={t('drawToolbar.redoAria')}
        disabled={!canRedo}
        {...rove('redo')}
        onClick={() => st.redo()}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M10 3l3.5 3.5L10 10M13 6.5H7a4 4 0 000 8h3" />
        </svg>
      </button>

      <button
        type="button"
        className="draw-toolbar__btn draw-toolbar__btn--danger"
        title={t('drawToolbar.clear', { scope })}
        aria-label={t('drawToolbar.clearAria')}
        disabled={itemCount === 0}
        {...rove('clear')}
        onClick={() => {
          const n = useDrawingsStore.getState().items.length;
          const question = n === 1
            ? t('drawToolbar.clearConfirmOne', { scope })
            : t('drawToolbar.clearConfirmMany', { count: n, scope });
          if (n > 0 && window.confirm(question)) {
            useDrawingsStore.getState().clearAll();
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.8 8.5h5.4l.8-8.5M6.8 7l.3 4.5M9.2 7l-.3 4.5" />
        </svg>
      </button>
    </div>
  );
}

export { toggleDrawToolbar };
