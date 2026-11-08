/**
 * IndicatorPicker — the popover over the chart that
 * manages the active indicator set.
 *
 * - Lists the REGISTRY (`indicators/registry.ts`): add/remove in one click,
 *   bounded by the store (8 active; the store evicts oldest past the bound).
 * - Active entries get PARAM editors (schema-driven min/max/step; every write
 *   is clamped in the store, so the kernels never see junk) and COLOR swatches
 *   per output (`<input type="color">`; the reset chip returns the theme var).
 * - The CANDLE SOURCE timeframe (1m/5m/15m) is selectable here and persists in
 *   localStorage via candles/store.
 * - `I` toggles it (self-listened with the app's typing/dialog guards, and off
 *   when single-key shortcuts are switched off); App can also bind
 *   {@link toggleIndicatorPicker} programmatically. Esc closes. Opening moves
 *   focus to the close button, and closing returns it to the opener (WCAG 2.4.3).
 *
 * Pure DOM + the store; no canvas, no timer loops. Closed = renders null.
 */

import { useEffect, useRef, useState } from 'react';

import { CANDLE_TIMEFRAMES, getSnapshot, setTimeframe } from '../candles/store';
import { useT } from '../i18n/useT';
import { INDICATOR_DEFS, defById } from '../indicators/registry';
import { indicatorName, outputLabel, paramLabel } from '../indicators/labels';
import { useIndicatorStore, MAX_ACTIVE_INDICATORS, orderConflict } from '../indicators/store';
import { classifyTarget } from '../input/keys';
import { isSingleKeyShortcutsEnabled } from '../input/shortcutPrefs';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { paramText, SeriesColorInput } from './IndicatorPickerControls';
import '../indicators/indicators.css';

export { toggleIndicatorPicker } from '../indicators/store';

export function IndicatorPicker(): JSX.Element | null {
  const t = useT();
  /** The indicator whose ordered-pair field was just moved by the store. */
  const [orderHint, setOrderHint] = useState<string | null>(null);
  const open = useIndicatorStore((s) => s.pickerOpen);
  const active = useIndicatorStore((s) => s.active);
  const closeRef = useRef<HTMLButtonElement>(null);

  // `I` toggles; Esc closes. Same focus-safety rules as the app router: never
  // while typing (a typed `i` is a search character), never while a modal owns
  // the keyboard (the drawer/shortcuts close themselves), and never for the bare
  // `I` when the user has switched single-key shortcuts off. Esc is not a
  // character key, so it stays live.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = classifyTarget(e.target);
      if (target.editable) return;
      if (e.key === 'Escape') {
        // A keystroke another surface already consumed stays consumed.
        if (e.defaultPrevented) return;
        // Esc belongs to the TOPMOST open overlay. The picker is one of them
        // (pushed while open), so a focus inside its own role=dialog does not
        // swallow the key, while a surface opened above it keeps its Escape.
        if (!useIndicatorStore.getState().pickerOpen || !isTopOverlay('indicator-picker')) return;
        useIndicatorStore.getState().setPickerOpen(false);
        return;
      }
      if (e.key !== 'i' && e.key !== 'I') return;
      // A held key auto-repeats; one press toggles the picker once.
      if (e.repeat) return;
      if (!isSingleKeyShortcutsEnabled()) return;
      // A no-op inside another dialog: its own keyboard owns the `I` key there. The
      // picker is itself a role=dialog, so focus inside it still toggles it shut.
      const ownPicker = e.target instanceof Element && e.target.closest('.indi-picker') !== null;
      if (target.dialog && !ownPicker) return;
      e.preventDefault();
      useIndicatorStore.getState().togglePicker();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Register on the overlay stack while open, so Escape resolves in LIFO order
  // with the drawer, palette and other modal surfaces.
  useEffect(() => (open ? pushOverlay('indicator-picker') : undefined), [open]);

  // The picker is a role=dialog: opening it by key must say so to a keyboard or
  // screen-reader user. Focus moves to its close button, and returns to the
  // opener when it closes (WCAG 2.4.3), as the other dialogs do.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, [open]);

  if (!open) return null;

  const tfNs = getSnapshot().timeframeNs;
  const atCap = active.length >= MAX_ACTIVE_INDICATORS;

  return (
    <div className="indi-picker" data-testid="indi-picker" role="dialog" aria-label={t('indi.title')}>
      <div className="indi-picker__head">
        <span className="indi-picker__title">{t('indi.title')}</span>
        <button
          type="button"
          className="indi-picker__close"
          data-testid="indi-close"
          ref={closeRef}
          aria-label={t('indi.close')}
          onClick={() => useIndicatorStore.getState().setPickerOpen(false)}
        >
          ×
        </button>
      </div>

      <label className="indi-picker__row">
        <span>{t('indi.candles')}</span>
        <select
          className="indi-picker__select"
          data-testid="indi-tf"
          value={String(tfNs)}
          onChange={(e) => setTimeframe(Number(e.target.value))}
        >
          {CANDLE_TIMEFRAMES.map((tf) => (
            <option key={tf.ns} value={String(tf.ns)}>
              {tf.label}
            </option>
          ))}
        </select>
      </label>

      <div className="indi-picker__scroll">
        <div>
          <div className="indi-picker__section">
            {t('indi.active', { count: active.length, max: MAX_ACTIVE_INDICATORS })}
          </div>
          {active.length === 0 ? (
            <div className="indi-picker__empty" data-testid="indi-active-empty">
              {t('indi.none')}
            </div>
          ) : (
            <ul className="indi-picker__list">
              {active.map((a) => {
                const def = defById(a.defId);
                if (def === null) return null;
                return (
                  <li key={a.uid} data-testid={`indi-active-${a.defId}`}>
                    <div className="indi-row">
                      <span className="indi-row__name">
                        {indicatorName(def.id, def.name)}
                        {def.params.length > 0 &&
                          ` (${def.params.map((p) => paramText(a.params[p.key])).join(' / ')})`}
                      </span>
                      <button
                        type="button"
                        className="indi-row__remove"
                        data-testid={`indi-remove-${a.uid}`}
                        aria-label={t('indi.remove', { name: indicatorName(def.id, def.name) })}
                        onClick={() => useIndicatorStore.getState().remove(a.uid)}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="indi-params">
                      {def.params.map((p) => (
                        <label key={p.key} className="indi-param">
                          <span>{paramLabel(p.key, p.label)}</span>
                          <input
                            type="number"
                            data-testid={`indi-param-${a.uid}-${p.key}`}
                            value={a.params[p.key]}
                            min={p.min}
                            max={p.max}
                            step={p.step}
                            onChange={(e) => {
                              const v = Number(e.target.value);
                              const moved = orderConflict(a.defId, a.params, p.key, v);
                              useIndicatorStore.getState().setParam(a.uid, p.key, v);
                              setOrderHint(moved ? a.uid : null);
                            }}
                          />
                        </label>
                      ))}
                      {orderHint === a.uid && (
                        <span className="indi-hint" role="status" data-testid={`indi-order-hint-${a.uid}`}>
                          {t('indi.orderAdjusted')}
                        </span>
                      )}
                      {def.outputs.map((o) => (
                        <span key={o.key} className="indi-color">
                          <SeriesColorInput
                            testId={`indi-color-${a.uid}-${o.key}`}
                            ariaLabel={t('indi.colorOf', { name: indicatorName(def.id, def.name), output: outputLabel(o.key, o.label) })}
                            override={a.colors[o.key] ?? null}
                            colorVar={o.colorVar}
                            onColor={(color) => useIndicatorStore.getState().setColor(a.uid, o.key, color)}
                          />
                          <button
                            type="button"
                            className="indi-color__reset"
                            data-testid={`indi-color-reset-${a.uid}-${o.key}`}
                            title={t('indi.themeDefault')}
                            onClick={() => useIndicatorStore.getState().setColor(a.uid, o.key, null)}
                          >
                            {t('indi.auto')}
                          </button>
                        </span>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="indi-picker__section">{t('indi.add')}</div>
          <ul className="indi-picker__list">
            {INDICATOR_DEFS.map((def) => (
              <li key={def.id} className="indi-row">
                <span className="indi-row__name">
                  {indicatorName(def.id, def.name)}
                  {def.params.length > 0 &&
                    ` (${def.params.map((p) => paramText(p.default)).join(' / ')})`}
                </span>
                <button
                  type="button"
                  className="indi-row__add"
                  data-testid={`indi-add-${def.id}`}
                  disabled={atCap}
                  title={atCap ? t('indi.limit', { max: MAX_ACTIVE_INDICATORS }) : undefined}
                  onClick={() => useIndicatorStore.getState().add(def.id)}
                >
                  {t('indi.add')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
