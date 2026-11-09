/**
 * Top bar — one tidy row: brand, dual-market symbol search, a
 * venue/market indicator, honest capability badges, the live/replay toggle, a
 * clock (wall time + the stream's latest ts), the connection status, the PNG
 * export button, and the rail + settings controls.
 *
 * Everything here is low-frequency: the store slices it reads (status / capability
 * / subscription / paused) update at human rate, the clock owns its own 1 Hz tick
 * (TopBarClock), and the stream clock is passed in from the App's ≤4 Hz timeline
 * poll. The heatmap stream never reaches this component.
 */

import { forwardRef } from 'react';

import { useT } from '../i18n/useT';

import type { StreamMode } from '../proto/types';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';
import { useFlowMapStore } from '../state/store';
import { useIntelligenceStore } from '../state/intelligenceStore';
import { FEED_KEY } from './MarketStrip';
import { SymbolSearch, type SymbolSearchHandle } from './SymbolSearch';
import { Wordmark } from './Wordmark';
import { capabilityChips, marketGroup } from './symbols';
import {
  CapabilityBadges,
  ExportPngButton,
  MacroTicker,
  ModeToggle,
  TopBarStatus,
  VenueChip,
} from './TopBarParts';
import { TopBarClock } from './TopBarClock';
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
// (ui/symbols.ts), the same function the symbol palette uses, so one string makes
// one fidelity claim on every surface.

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
  // The bare key hints (J here) only name a key while single-key shortcuts are on.
  const singleKeys = useSingleKeyShortcuts();

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
  const feedKey = feedState && feedState !== 'live' ? (FEED_KEY[feedState] ?? 'marketStrip.feed.other') : null;
  const feedLabel = feedKey ? t(feedKey) : '';

  return (
    <header className="topbar">
      <span className="topbar__brand">
        <Wordmark height={24} />
      </span>

      <SymbolSearch ref={searchRef} current={`${market}:${symbol}`} onSelect={onSelectSymbol} />

      <VenueChip market={market} symbol={symbol} group={group} chips={chips} />

      {/* Persistent while the simulated feed is the source (the sim market, or any feed that reports
          itself synthetic), so fixtures are never mistaken for a market. */}
      {showSimBadge && (
        <span className="topbar__sim" data-testid="sim-badge" title={t('topbar.simBadgeTitle')}>
          {t('topbar.simBadge')}
        </span>
      )}

      <CapabilityBadges pending={capability === null} chips={chips} />

      {/* Institutional Macro & Liquidity Stress Ticker (MACRO <GO>) */}
      <MacroTicker macro={macro} />

      <span className="topbar__spacer" />

      {/* Replay surfaces ONLY when the server advertises the capability: this
          build's server refuses mode=replay (no engine — the controls would
          steer nothing), so an always-on toggle would be a dead control. */}
      <ModeToggle mode={mode} replayAvailable={capability?.replay === true} onSetMode={onSetMode} />

      <TopBarStatus
        status={status}
        statusText={statusText}
        feedLabel={feedLabel}
        replayUnavailable={replayUnavailable}
        recordingDegraded={recordingDegraded}
      />

      <TopBarClock group={group} streamClock={streamClock} />

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

      <ExportPngButton onExportPng={onExportPng} />

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
