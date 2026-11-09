/**
 * The groups of the Settings drawer. SettingsDrawer.tsx owns the drawer chrome,
 * focus handling, the theme picker and the restore and undo actions; each section
 * below renders one group of settings and writes its changes through `onChange`.
 */

import { useState } from 'react';

import { CHART_STYLES } from '../gl/heatmap';
import type { OverlayVisibility } from '../gl/overlays/frame';
import { LOCALES, getLocale, localeLabel, setLocale } from '../i18n';
import { formatNumber, setTimeZonePref, TIME_ZONE_PREFS, useTimeZone } from '../i18n/format';
import { useT } from '../i18n/useT';
import { toggleDrawToolbar, useDrawingsStore } from '../drawings/store';
import { useIndicatorStore } from '../indicators/store';
import { setSingleKeyShortcutsEnabled, useSingleKeyShortcuts } from '../input/shortcutPrefs';
import { COLORMAP_CATALOG, resolveAppearance, stopsGradient } from '../theme/appearance';
import { useTheme } from '../theme';
import { toggleIndicatorPicker } from './IndicatorPicker';
import { openOnboarding } from './OnboardingCard';
import { OverlayToggles } from './OverlayToggles';
import { KeysheetRows } from './keysheetList';
import {
  DEPTH_CHANNEL_HINT_KEY,
  DEPTH_CHANNEL_LABEL_KEY,
  DEPTH_CHANNELS,
  HISTORY_DEPTH_LABEL_KEY,
  HISTORY_DEPTHS,
  PRICE_BAND_HINT_KEY,
  PRICE_BAND_LABEL_KEY,
  PRICE_BANDS,
  type FlowMapSettings,
} from './settings';

/**
 * Tick-grouping levels the renderer can draw. It rounds the row count up to a
 * power of four, so each level here draws a different number of rows.
 */
const TICK_LEVELS = [1, 4, 16] as const;
/** Rows drawn per heatmap cell for a tick-grouping value (the renderer's rounding). */
const rowsFor = (grouping: number): number => 4 ** Math.ceil(Math.log2(grouping) / 2);

interface SettingsSectionProps {
  settings: FlowMapSettings;
  onChange: (patch: Partial<FlowMapSettings>) => void;
}

export function SettingsAppearanceSection({
  settings,
  onChange,
  onOpenAbout,
  onCloseDrawer,
}: SettingsSectionProps & { onOpenAbout?: () => void; onCloseDrawer?: () => void }): JSX.Element {
  const t = useT(); // re-renders on locale change
  const toolbarVisible = useDrawingsStore((s) => s.toolbarVisible);
  const pickerOpen = useIndicatorStore((s) => s.pickerOpen);
  const singleKeys = useSingleKeyShortcuts();
  // The picker is drawn in the chart, under this drawer's scrim. Opening it from
  // here closes the drawer, so focus lands on the picker's own close button rather
  // than on a control the scrim hides. Closing the picker keeps the drawer open.
  const onPickerSwitch = (): void => {
    toggleIndicatorPicker();
    if (!pickerOpen) onCloseDrawer?.();
  };
  return (
    <>
      {/* language picker (i18n shell: EN default + TR). useT() above makes
          the whole drawer re-render the moment setLocale lands. */}
      <div className="setting">
        <span className="setting__label">{t('settings.language')}</span>
        <div className="segrow" role="group" aria-label={t('settings.language')} data-testid="setting-locale">
          {LOCALES.map((l) => (
            <button
              type="button"
              key={l}
              className={`segrow__btn${getLocale() === l ? ' is-on' : ''}`}
              aria-pressed={getLocale() === l}
              data-testid={`locale-${l}`}
              onClick={() => setLocale(l)}
            >
              {localeLabel(l)}
            </button>
          ))}
        </div>
      </div>

      {/* panel toggles — surfaces whose setters live in the feature stores */}
      <button
        type="button"
        role="switch"
        aria-checked={settings.hudVisible}
        className={`check${settings.hudVisible ? ' is-on' : ''}`}
        data-testid="toggle-hud"
        onClick={() => onChange({ hudVisible: !settings.hudVisible })}
      >
        {t(singleKeys ? 'settings.hud' : 'settings.hudNoKey')}
        <span className="check__box" aria-hidden="true" />
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={toolbarVisible}
        className={`check${toolbarVisible ? ' is-on' : ''}`}
        data-testid="toggle-draw-toolbar"
        onClick={toggleDrawToolbar}
      >
        {t(singleKeys ? 'settings.drawToolbar' : 'settings.drawToolbarNoKey')}
        <span className="check__box" aria-hidden="true" />
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={pickerOpen}
        className={`check${pickerOpen ? ' is-on' : ''}`}
        data-testid="toggle-indicator-picker"
        onClick={onPickerSwitch}
      >
        {t(singleKeys ? 'settings.indicatorPicker' : 'settings.indicatorPickerNoKey')}
        <span className="check__box" aria-hidden="true" />
      </button>

      {/* re-run the first-run wizard (Skip/Done persist; Esc only hides) */}
      <button
        type="button"
        className="drawer__restore"
        data-testid="show-onboarding"
        onClick={openOnboarding}
      >
        {t('settings.showOnboarding')}
      </button>
      {onOpenAbout && (
        <button
          type="button"
          className="drawer__restore"
          data-testid="open-about"
          onClick={onOpenAbout}
        >
          {t('settings.about')}
        </button>
      )}
    </>
  );
}

export function SettingsDisplaySection({
  settings,
  onChange,
  synthetic,
  densityControlsDisabled,
}: SettingsSectionProps & { synthetic: boolean; densityControlsDisabled: boolean }): JSX.Element {
  const t = useT();
  const zonePref = useTimeZone();
  const { theme } = useTheme();
  const singleKeys = useSingleKeyShortcuts();
  // The imbalance hint says the channel cycles with C, which the switch can turn off.
  const channelHintKey = settings.depthChannel === 'imbalance' && !singleKeys
    ? 'settings.channelHint.imbalanceNoKey'
    : DEPTH_CHANNEL_HINT_KEY[settings.depthChannel];
  return (
    <>
      <h3 className="drawer__section" data-testid="section-display">
        {t('drawer.sectionDisplay')}
      </h3>
      {densityControlsDisabled && (
        <span className="setting__hint" data-testid="setting-imbalance-hint">
          {t('settings.imbalanceDisplayHint')}
        </span>
      )}

      {/* heatmap contrast (drives the perceptual display gamma; live) */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.contrast')}
          <span className="setting__value">{settings.contrast}</span>
        </span>
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          step={1}
          value={settings.contrast}
          aria-label={t('settings.contrast')}
          aria-valuetext={`${settings.contrast}`}
          data-testid="setting-contrast"
          disabled={densityControlsDisabled}
          onChange={(e) => onChange({ contrast: Number(e.target.value) })}
        />
        <span className="setting__hint">{t('settings.contrastHint')}</span>
      </div>

      {/* colormap */}
      <div className="setting">
        <span className="setting__label">{t('settings.colormap')}</span>
        <div className="appearance-grid" role="group" aria-label={t('settings.colormap')} data-testid="setting-colormap">
          {COLORMAP_CATALOG.map(({ id: c, label, nameKey, hint }) => (
            <button
              type="button"
              key={c}
              className={`appearance-choice${settings.colormap === c ? ' is-on' : ''}`}
              aria-pressed={settings.colormap === c}
              data-testid={`colormap-${c}`}
              disabled={densityControlsDisabled}
              onClick={() => onChange({ colormap: c })}
            >
              <span className="palette-preview" aria-hidden="true" style={{ background: `linear-gradient(to right, ${stopsGradient(resolveAppearance(theme, c).density)})` }} />
              <span className="appearance-choice__name">{nameKey ? t(nameKey) : label}<span aria-hidden="true">{settings.colormap === c ? '✓' : ''}</span></span>
              <span className="appearance-choice__hint">{t(`palette.${hint}`)}</span>
            </button>
          ))}
        </div>
        <span className="setting__hint">{t('settings.colormapHint')}</span>
      </div>

      {/* chart style: normal is the default; pixel is
          opt-in. Applied live via renderer.setChartStyle, with no reload. */}
      <div className="setting">
        <span className="setting__label" id="chart-style-label">{t('settings.chartStyle')}</span>
        <div className="segrow" role="radiogroup" aria-labelledby="chart-style-label" data-testid="setting-chartStyle">
          {CHART_STYLES.map((c) => (
            <button
              type="button"
              key={c}
              role="radio"
              className={`segrow__btn${settings.chartStyle === c ? ' is-on' : ''}`}
              aria-checked={settings.chartStyle === c}
              data-testid={`chartStyle-${c}`}
              onClick={() => onChange({ chartStyle: c })}
            >
              {t(`settings.chartStyle.${c}`)}
            </button>
          ))}
        </div>
        <span className="setting__hint">{t('settings.chartStyleHint')}</span>
      </div>

      {/* time zone: clock times follow this preference. format.ts owns the store, so the
          Tape, top bar, axes and crosshair re-render together when it changes. */}
      <div className="setting">
        <span className="setting__label" id="time-zone-label">{t('settings.timeZone')}</span>
        <div className="segrow" role="radiogroup" aria-labelledby="time-zone-label" data-testid="setting-timeZone">
          {TIME_ZONE_PREFS.map((pref) => (
            <button
              type="button"
              key={pref}
              role="radio"
              className={`segrow__btn${zonePref === pref ? ' is-on' : ''}`}
              aria-checked={zonePref === pref}
              data-testid={`timeZone-${pref}`}
              onClick={() => setTimeZonePref(pref)}
            >
              {t(`settings.tz.${pref}`)}
            </button>
          ))}
        </div>
        <span className="setting__hint">{t('settings.timeZoneHint')}</span>
      </div>

      {/* depth display channel — applied via renderer.setDepthChannel */}
      <div className="setting">
        <span className="setting__label">{t('settings.depthChannel')}</span>
        <div className="segrow" role="group" aria-label={t('settings.depthChannel')} data-testid="setting-depthChannel">
          {DEPTH_CHANNELS.map((c) => (
            <button
              type="button"
              key={c}
              className={`segrow__btn${settings.depthChannel === c ? ' is-on' : ''}`}
              aria-pressed={settings.depthChannel === c}
              data-testid={`depthChannel-${c}`}
              disabled={synthetic && c !== 'sum'}
              onClick={() => onChange({ depthChannel: c })}
            >
              {t(DEPTH_CHANNEL_LABEL_KEY[c])}
            </button>
          ))}
        </div>
        <span className="setting__hint">{t(synthetic ? 'settings.channelSyntheticHint' : channelHintKey)}</span>
      </div>

      {/* normalization percentile */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.normalization')}
          <span className="setting__value">p{settings.normPercentile}</span>
        </span>
        <input
          type="range"
          className="range"
          min={80}
          max={100}
          step={0.1}
          value={settings.normPercentile}
          aria-label={t('settings.normalization')}
          aria-valuetext={`p${settings.normPercentile}`}
          data-testid="setting-normPercentile"
          disabled={densityControlsDisabled}
          onChange={(e) => onChange({ normPercentile: Number(e.target.value) })}
        />
        <span className="setting__hint">{t('settings.normalizationHint')}</span>
      </div>

      {/* Raw slider position; the visible depth CDF calibrates its cut. */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.tolerance')}
          <span className="setting__value">
            {settings.tolerance > 0 ? settings.tolerance : t('settings.off')}
          </span>
        </span>
        <input
          type="range"
          className="range"
          min={0}
          max={100}
          step={1}
          value={settings.tolerance}
          aria-label={t('settings.tolerance')}
          aria-valuetext={settings.tolerance > 0 ? `${settings.tolerance}` : t('settings.off')}
          data-testid="setting-tolerance"
          disabled={densityControlsDisabled}
          onChange={(e) => onChange({ tolerance: Number(e.target.value) })}
        />
        <span className="setting__hint">{t('settings.toleranceHint')}</span>
      </div>
    </>
  );
}

export function SettingsTradesSection({ settings, onChange }: SettingsSectionProps): JSX.Element {
  const t = useT();
  // Numeric fields keep the text being typed, so clearing a field does not
  // write 0 straight away and re-render a stray zero under the cursor.
  const [bubbleDraft, setBubbleDraft] = useState<string | null>(null);
  const [bigTradeDraft, setBigTradeDraft] = useState<string | null>(null);
  const rowsPerCell =
    settings.tickGrouping === 1
      ? t('settings.rowsPerCellOne')
      : t('settings.rowsPerCell', { n: rowsFor(settings.tickGrouping) });
  return (
    <>
      <h3 className="drawer__section" data-testid="section-trades">
        {t('drawer.sectionTrades')}
      </h3>

      {/* tick grouping */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.tickGrouping')}
          <span className="setting__value">{rowsPerCell}</span>
        </span>
        <div className="segrow" role="group" aria-label={t('settings.tickGrouping')} data-testid="setting-tickGrouping">
          {TICK_LEVELS.map((n) => {
            const on = rowsFor(settings.tickGrouping) === rowsFor(n);
            return (
              <button
                type="button"
                key={n}
                className={`segrow__btn${on ? ' is-on' : ''}`}
                aria-pressed={on}
                data-testid={`tickGrouping-${n}`}
                onClick={() => onChange({ tickGrouping: n })}
              >
                {n === 1 ? t('settings.rowsPerCellOne') : t('settings.rowsPerCell', { n: rowsFor(n) })}
              </button>
            );
          })}
        </div>
        <span className="setting__hint">{t('settings.tickGroupingHint')}</span>
      </div>

      {/* bubble threshold */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.bubble')}
          <span className="setting__value">
            {settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : t('settings.allTrades')}
          </span>
        </span>
        <input
          type="number"
          className="setting__num"
          min={0}
          max={1e9}
          step="any"
          value={bubbleDraft ?? settings.bubbleMinSize}
          aria-label={t('settings.bubbleThreshold')}
          aria-valuetext={settings.bubbleMinSize > 0 ? `≥ ${settings.bubbleMinSize}` : t('settings.allTrades')}
          data-testid="setting-bubble"
          onChange={(e) => {
            const raw = e.target.value;
            setBubbleDraft(raw);
            const value = Number(raw);
            // An empty or half-typed field keeps the last valid value.
            if (raw.trim() === '' || !Number.isFinite(value)) return;
            onChange({ bubbleMinSize: Math.min(1e9, Math.max(0, value)) });
          }}
          onBlur={() => setBubbleDraft(null)}
        />
        <span className="setting__hint">{t('settings.bubbleHint')}</span>
      </div>

      {/* Price × native quantity threshold; the stored key is historical. */}
      <div className="setting">
        <span className="setting__label">
          {t('settings.bigTradeLabel')}
          <span className="setting__value">
            {settings.bigTradeUsd > 0
              ? `≥ $${formatNumber(Math.round(settings.bigTradeUsd))}`
              : t('settings.off')}
          </span>
        </span>
        <input
          type="number"
          className="setting__num"
          min={0}
          step={1000}
          value={bigTradeDraft ?? settings.bigTradeUsd}
          aria-label={t('settings.bigTrade')}
          data-testid="setting-bigTradeUsd"
          onChange={(e) => {
            const raw = e.target.value;
            setBigTradeDraft(raw);
            // Empty or unparseable: keep the stored value until a number lands.
            if (raw.trim() === '') return;
            const n = Number(raw);
            if (!Number.isFinite(n)) return;
            // Same ceiling normalizeSettings applies on load, so the live
            // value and the next load agree.
            onChange({ bigTradeUsd: n > 0 ? Math.min(n, 1e9) : 0 });
          }}
          onBlur={() => setBigTradeDraft(null)}
        />
        <span className="setting__hint">{t('settings.bigTradeHint')}</span>
      </div>
    </>
  );
}

export function SettingsViewSection({ settings, onChange }: SettingsSectionProps): JSX.Element {
  const t = useT();
  return (
    <>
      <h3 className="drawer__section" data-testid="section-view">
        {t('drawer.sectionView')}
      </h3>

      {/* follow mode */}
      <button
        type="button"
        role="switch"
        aria-checked={settings.follow}
        className={`check${settings.follow ? ' is-on' : ''}`}
        data-testid="toggle-follow"
        onClick={() => onChange({ follow: !settings.follow })}
      >
        {t('settings.followLive')}
        <span className="check__box" aria-hidden="true" />
      </button>

      {/* price auto-follow */}
      <button
        type="button"
        role="switch"
        aria-checked={settings.followPrice}
        className={`check${settings.followPrice ? ' is-on' : ''}`}
        data-testid="toggle-follow-price"
        onClick={() => onChange({ followPrice: !settings.followPrice })}
      >
        {t('settings.followPrice')}
        <span className="check__box" aria-hidden="true" />
      </button>

      {/* server price band — changing it re-subscribes */}
      <div className="setting">
        <span className="setting__label">{t('settings.priceRange')}</span>
        <div className="segrow" role="group" aria-label={t('settings.priceRange')} data-testid="setting-priceBand">
          {PRICE_BANDS.map((b) => (
            <button
              type="button"
              key={b}
              className={`segrow__btn${settings.priceBand === b ? ' is-on' : ''}`}
              aria-pressed={settings.priceBand === b}
              data-testid={`priceBand-${b}`}
              onClick={() => onChange({ priceBand: b })}
            >
              {t(PRICE_BAND_LABEL_KEY[b])}
            </button>
          ))}
        </div>
        <span className="setting__hint">{t(PRICE_BAND_HINT_KEY[settings.priceBand])}</span>
      </div>

      {/* first-launch history depth */}
      <div className="setting">
        <span className="setting__label">{t('settings.historyDepth')}</span>
        <div className="segrow" role="group" aria-label={t('settings.historyDepth')} data-testid="setting-historyDepth">
          {HISTORY_DEPTHS.map((d) => (
            <button
              type="button"
              key={d}
              className={`segrow__btn${settings.historyDepth === d ? ' is-on' : ''}`}
              aria-pressed={settings.historyDepth === d}
              data-testid={`historyDepth-${d}`}
              onClick={() => onChange({ historyDepth: d })}
            >
              {t(HISTORY_DEPTH_LABEL_KEY[d])}
            </button>
          ))}
        </div>
        <span className="setting__hint">{t('settings.historyHint')}</span>
      </div>

      {/* right rail */}
      <button
        type="button"
        role="switch"
        aria-checked={settings.railVisible}
        className={`check${settings.railVisible ? ' is-on' : ''}`}
        data-testid="toggle-rail"
        onClick={() => onChange({ railVisible: !settings.railVisible })}
      >
        {t('settings.rightRail')}
        <span className="check__box" aria-hidden="true" />
      </button>
    </>
  );
}

export function SettingsOverlaysSection({ settings, onChange }: SettingsSectionProps): JSX.Element {
  const t = useT();
  const alertSound = settings.alertSound;
  const toggleOverlay = (key: keyof OverlayVisibility): void => {
    onChange({ overlays: { ...settings.overlays, [key]: !settings.overlays[key] } });
  };
  const toggleAlertSound = (): void => onChange({ alertSound: !alertSound });
  return (
    <>
      <h3 className="drawer__section" data-testid="section-overlays">
        {t('settings.overlays')}
      </h3>

      {/* overlays */}
      <div className="setting">
        <OverlayToggles visibility={settings.overlays} onToggle={toggleOverlay} />
      </div>

      {/* alerts: sound toggle for fired price alerts; the alert sound module owns the playback */}
      <h3 className="drawer__section" data-testid="section-alerts">
        {t('drawer.sectionAlerts')}
      </h3>
      <div className="setting">
        <button
          type="button"
          role="switch"
          aria-checked={alertSound}
          className={`check${alertSound ? ' is-on' : ''}`}
          data-testid="toggle-alert-sound"
          onClick={toggleAlertSound}
        >
          {t('settings.alertSound')}
          <span className="check__box" aria-hidden="true" />
        </button>
        <span className="setting__hint">{t('settings.alertSoundHint')}</span>
      </div>
    </>
  );
}

export function SettingsKeysSection(): JSX.Element {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  return (
    <>
      {/* keyboard reference: the same rows as the ? overlay (ui/keysheet.ts) */}
      <h3 className="drawer__section" data-testid="section-keys">
        {t('drawer.sectionKeyboard')}
      </h3>
      <div className="setting">
        <button
          type="button"
          role="switch"
          aria-checked={singleKeys}
          className={`check${singleKeys ? ' is-on' : ''}`}
          data-testid="toggle-single-keys"
          onClick={() => setSingleKeyShortcutsEnabled(!singleKeys)}
        >
          {t('shortcuts.singleKeys')}
          <span className="check__box" aria-hidden="true" />
        </button>
        <span className="setting__hint">{t(singleKeys ? 'shortcuts.singleKeysHint' : 'shortcuts.singleKeysOffHint')}</span>
      </div>
      <div className="keysheet" data-testid="keysheet">
        {/* With the switch off a bare key does nothing, so its row is marked off, not hidden. */}
        <KeysheetRows singleKeys={singleKeys} />
      </div>
    </>
  );
}
