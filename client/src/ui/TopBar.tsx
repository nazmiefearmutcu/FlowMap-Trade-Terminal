/**
 * Top bar — one tidy row: brand, dual-market symbol search, a
 * venue/market indicator, honest capability badges, the live/replay toggle, a
 * clock (wall time + the stream's latest ts), the connection status, the PNG
 * export button, and the rail + settings controls.
 *
 * Everything here is low-frequency: the store slices it reads (status / capability
 * / subscription / paused) update at human rate, the wall clock ticks at 1 Hz, and
 * the stream clock is passed in from the App's ≤4 Hz timeline poll. The heatmap
 * stream never reaches this component.
 */

import { forwardRef, useEffect, useState } from 'react';

import { useT } from '../i18n/useT';
import { exchangeZoneFor, formatClock, formatFixed, useTimeZone, zoneLabel } from '../i18n/format';

import type { StreamMode } from '../proto/types';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';
import { useFlowMapStore } from '../state/store';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { FEED_KEY } from './MarketStrip';
import { SymbolSearch, type SymbolSearchHandle } from './SymbolSearch';
import { Wordmark } from './Wordmark';
import {
  capabilityChipClass,
  capabilityChipLabel,
  capabilityChipTitle,
  capabilityChips,
  marketGroup,
  venueGroupLabel,
  venueLabel,
} from './symbols';
import { stressRegimeLabel } from './TopBarLabels';
import './TopBar.css';

/** Connection state → its translation key (raw transport tokens never reach the screen). */
export const STATUS_KEY: Record<string, string> = {
  idle: 'status.idle',
  connecting: 'status.connecting',
  live: 'status.live',
  reconnecting: 'status.reconnecting',
  closed: 'status.closed',
};

// Capability chips are classified by the ONE shared `capabilityChipClass`
// (ui/symbols.ts), the same function the symbol palette uses. This file used to
// carry its own copy, and the two drifted: the same `SYNTH_PROFILE` string read
// as fabricated depth here and as real depth in the palette. One string, one
// fidelity claim, every surface.

interface TopBarProps {
  onSelectSymbol: (market: string, symbol: string) => void;
  onSetMode: (mode: StreamMode) => void;
  railVisible: boolean;
  onToggleRail: () => void;
  onOpenSettings: () => void;
  onToggleIntel?: () => void;
  /** Export the chart canvas as a PNG download (renderer snapshot; `E` shares it). */
  onExportPng: () => void;
  /** Non-null when the last export attempt was refused (lost GL context). */
  exportNotice: string | null;
  onDismissExportNotice: () => void;
  /** Formatted latest-stream timestamp from the App's timeline poll (or null). */
  streamClock: string | null;
}

export const TopBar = forwardRef<SymbolSearchHandle, TopBarProps>(function TopBar(
  {
    onSelectSymbol,
    onSetMode,
    railVisible,
    onToggleRail,
    onOpenSettings,
    onExportPng,
    exportNotice,
    onDismissExportNotice,
    streamClock,
    onToggleIntel,
  },
  searchRef,
) {
  const t = useT(); // i18n shell pass — re-renders on locale change
  const status = useFlowMapStore((s) => s.status);
  const feedState = useFlowMapStore((s) => s.feedState);
  const capability = useFlowMapStore((s) => s.capability);
  const subscription = useFlowMapStore((s) => s.subscription);
  const replayUnavailable = useFlowMapStore((s) => s.replayUnavailable);
  const recordingDegraded = useFlowMapStore((s) => s.recordingDegraded);
  const macro = useIntelligenceStore((s) => s.macro);
  // The bare `E` hint only names a key while single-key shortcuts are on.
  const singleKeys = useSingleKeyShortcuts();

  const [wall, setWall] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setWall(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // One zone preference (Settings → Time zone) drives every clock on the bar.
  const zonePref = useTimeZone();

  const market = subscription?.market ?? 'sim';
  const symbol = subscription?.symbol ?? 'SIM-DEMO';
  const mode: StreamMode = subscription?.mode ?? 'live';
  const group = marketGroup(market);
  const chips = capabilityChips(capability);
  // The SIM badge follows the server's word: `synthetic` decides it once the
  // capability has arrived. Only before that does the market name stand in for it.
  const showSimBadge = capability ? capability.synthetic === true : market === 'sim';
  const statusKey = STATUS_KEY[status];
  const statusText = statusKey ? t(statusKey) : status;
  const exchangeZone = exchangeZoneFor(group);
  const wallMs = wall.getTime();
  const wallText = formatClock(wallMs, zonePref, exchangeZone);
  const zoneAbbrev = zoneLabel(zonePref, exchangeZone, wallMs);
  // For equity sessions the reference clock is US-eastern; show it beside the stream ts
  // unless the preference already reads exchange time.
  const etText =
    group === 'equity' && zonePref !== 'exchange' ? formatClock(wallMs, 'exchange', 'America/New_York') : null;
  const feedKey = feedState && feedState !== 'live' ? (FEED_KEY[feedState] ?? 'marketStrip.feed.other') : null;
  const feedLabel = feedKey ? t(feedKey) : '';
  const feedSuffix = feedLabel ? ` · ${feedLabel}` : '';

  return (
    <header className="topbar">
      <span className="topbar__brand">
        <Wordmark height={24} />
      </span>

      <SymbolSearch ref={searchRef} current={`${market}:${symbol}`} onSelect={onSelectSymbol} />

      {/* The venue, not just its asset class: with ~106 reachable venues "Crypto"
          no longer says WHERE the book is coming from, so a crypto session names
          the market string (`kraken`, `binance-usdm`) it is actually subscribed
          to. Equity / sim keep their group word — there the group IS the venue. */}
      <span
        className={`venue venue--${group}`}
        data-testid="venue"
        // The fidelity claim travels with the venue name, so it survives the
        // narrow-window hiding of the chip row: L2 vs SYNTH is never silent.
        title={`${market} · ${symbol} · ${venueGroupLabel(group, t)}${chips.length > 0 ? ` · ${chips.join(' · ')}` : ''}`}
      >
        <span className="venue__dot" aria-hidden="true" />
        {venueLabel(market, t)}
        <strong className="venue__symbol">{symbol}</strong>
      </span>

      {/* Persistent while the simulated feed is the source (the sim market, or any feed that reports
          itself synthetic), so fixtures are never mistaken for a market. */}
      {showSimBadge && (
        <span className="topbar__sim" data-testid="sim-badge" title={t('topbar.simBadgeTitle')}>
          {t('topbar.simBadge')}
        </span>
      )}

      <span className="caps" data-testid="capability-badges">
        {capability === null ? (
          // Pre-Hello: caps aren't loaded yet — a neutral placeholder, NOT "none".
          <span className="cap cap--pending" aria-hidden="true">—</span>
        ) : chips.length === 0 ? (
          // Received a descriptor that genuinely advertises no capabilities.
          <span className="cap cap--na">{t('topbar.noCaps')}</span>
        ) : (
          chips.map((c) => (
            <span key={c} className={capabilityChipClass(c)} title={capabilityChipTitle(c, t)}>
              {capabilityChipLabel(c, t)}
            </span>
          ))
        )}
      </span>

      {/* Institutional Macro & Liquidity Stress Ticker (MACRO <GO>) */}
      <div
        className="macro-ticker"
        data-available={macro !== null}
        data-testid="institutional-stress-ticker"
        title={macro ? t('topbar.macroTitle') : t('topbar.macroUnavailable')}
      >
        <span className="macro-ticker__lbl">{t('topbar.macro')}</span>
        <span className="macro-ticker__item">
          SOFR <strong>{macro ? `${formatFixed(macro.sofrRate, 2)}%` : '—'}</strong>
        </span>
        <span className="macro-ticker__div">|</span>
        <span className="macro-ticker__item">
          HY OAS <strong>{macro ? `${formatFixed(macro.hySpreadBps, 0)} ${t('unit.bps')}` : '—'}</strong>
        </span>
        <span className="macro-ticker__div">|</span>
        <span className={`macro-ticker__item ${macro ? (macro.yieldCurve10Y2Y < 0 ? 'is-neg' : 'is-pos') : ''}`}>
          10Y-2Y <strong>{macro ? `${macro.yieldCurve10Y2Y < 0 ? '' : '+'}${formatFixed(macro.yieldCurve10Y2Y, 2)}%` : '—'}</strong>
        </span>
        <span className={`macro-ticker__badge is-${macro?.stressRegime.toLowerCase() ?? 'unavailable'}`} title={macro?.status}>
          {macro ? stressRegimeLabel(macro.stressRegime, t) : t('topbar.unavailable')}
        </span>
      </div>

      <span className="topbar__spacer" />

      {/* Replay surfaces ONLY when the server advertises the capability: this
          build's server refuses mode=replay (no engine — the controls would
          steer nothing), so an always-on toggle would be a dead control. */}
      <div className="modeseg" role="group" aria-label={t('topbar.liveOrReplay')} data-testid="mode-toggle">
        <button
          type="button"
          data-mode="live"
          className={`modeseg__btn${mode === 'live' ? ' is-on' : ''}`}
          aria-pressed={mode === 'live'}
          data-testid="mode-live"
          onClick={() => onSetMode('live')}
        >
          {t('topbar.live')}
        </button>
        {capability?.replay === true && (
          <button
            type="button"
            data-mode="replay"
            className={`modeseg__btn${mode === 'replay' ? ' is-on' : ''}`}
            aria-pressed={mode === 'replay'}
            data-testid="mode-replay"
            onClick={() => onSetMode('replay')}
          >
            {t('topbar.replay')}
          </button>
        )}
      </div>

      <span
        className={`status status--${status}`}
        data-testid="conn-status"
        role="status"
        aria-live="polite"
        aria-label={`${t('topbar.connectionAria', { status: statusText })}${feedLabel ? t('topbar.feedAria', { feed: feedLabel }) : ''}`}
      >
        <span className="status__dot" aria-hidden="true" />
        {statusText}
        {feedSuffix}
      </span>

      {/* When a Replay toggle was refused (1003 — this symbol has no
          recording), say exactly that instead of leaving the user to guess why
          the replay never started. Cleared by the live fallback's handshake. */}
      {replayUnavailable && (
        <span
          className="replay-unavailable"
          data-testid="replay-unavailable"
          role="status"
          title={t('topbar.replayUnavailableHint')}
        >
          {t('topbar.replayUnavailable')}
        </span>
      )}

      {/* The recorder stopped saving new data for this session: a replay of later
          times would be incomplete, so say so beside the replay toggle. The full
          sentence is announced once by the app notice stack, so this chip is not a
          live region. */}
      {recordingDegraded && (
        <span
          className="recording-stalled"
          data-testid="recording-stalled-chip"
          title={t('banner.recordingDegraded')}
        >
          {t('topbar.recordingStalled')}
        </span>
      )}

      <span
        className="clock"
        data-testid="clock"
        aria-label={`${t('topbar.wallClockAria', { time: wallText, zone: zoneAbbrev })}${
          etText ? t('topbar.easternAria', { time: etText }) : ''
        }${t('topbar.streamAria', { stream: streamClock ?? t('topbar.streamNone') })}${
          streamClock ? (group === 'sim' ? t('topbar.sessionRelative') : t('topbar.utcSuffix')) : ''
        }`}
      >
        <span className="clock__wall">
          {wallText} <span className="clock__zone">{zoneAbbrev}</span>
        </span>
        {etText ? <span className="clock__et">{etText} {t('topbar.easternShort')}</span> : null}
        {/* The sim's stream ts is SESSION-RELATIVE (a T+ clock): it never gets a UTC label. */}
        <span className="clock__stream">
          {streamClock
            ? group === 'sim'
              ? t('topbar.clockStreamRelative', { time: streamClock })
              : t('topbar.clockStreamUtc', { time: streamClock })
            : '—'}
        </span>
      </span>

      {/* A refused export (renderer snapshot null — lost GL context) says so
          plainly and stays dismissible; it never fakes a success. */}
      {exportNotice && (
        <span className="export-note" data-testid="export-notice" role="status">
          {exportNotice}
          <button
            type="button"
            className="export-note__close"
            onClick={onDismissExportNotice}
            aria-label={t('topbar.dismissNotice')}
            data-testid="export-notice-close"
          >
            ✕
          </button>
        </span>
      )}

      <button
        type="button"
        className="tbtn"
        onClick={onExportPng}
        data-testid="export-png"
        aria-label={t('topbar.exportPng')}
        title={singleKeys ? t('topbar.exportPngHint') : t('topbar.exportPngHintNoKey')}
      >
        <svg
          className="tbtn__icon"
          viewBox="0 0 16 16"
          width="13"
          height="13"
          aria-hidden="true"
          focusable="false"
        >
          {/* Camera body + lens, filled with currentColor like the wordmark. */}
          <path
            d="M5.6 2.5 4.8 4H2.6A1.6 1.6 0 0 0 1 5.6v6.3A1.6 1.6 0 0 0 2.6 13.5h10.8a1.6 1.6 0 0 0 1.6-1.6V5.6A1.6 1.6 0 0 0 13.4 4h-2.2l-.8-1.5a.9.9 0 0 0-.8-.5H6.4a.9.9 0 0 0-.8.5Zm2.4 8.2a2.9 2.9 0 1 1 0-5.8 2.9 2.9 0 0 1 0 5.8Zm0-1.4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"
            fill="currentColor"
            fillRule="evenodd"
          />
        </svg>
        {t('topbar.png')}
      </button>

      <button
        type="button"
        className={`tbtn${railVisible ? ' is-on' : ''}`}
        aria-pressed={railVisible}
        onClick={onToggleRail}
        data-testid="rail-toggle"
        title={t('topbar.toggleRail')}
      >
        {t('topbar.rail')}
      </button>

      {onToggleIntel && (
        <button
          type="button"
          className="tbtn is-intel"
          onClick={onToggleIntel}
          data-testid="intel-toggle"
          title={singleKeys ? t('topbar.intelTitle') : t('topbar.intelTitleNoKey')}
        >
          {t('topbar.intelligence')}
        </button>
      )}

      <button
        type="button"
        className="tbtn"
        onClick={onOpenSettings}
        data-testid="settings-open"
        title={t('topbar.settings')}
        aria-haspopup="dialog"
      >
        {/* Force text (monochrome) presentation of the gear via U+FE0E, not the color emoji. */}
        <span aria-hidden="true">{'⚙︎'}</span> {t('topbar.settingsLabel')}
      </button>
    </header>
  );
});
