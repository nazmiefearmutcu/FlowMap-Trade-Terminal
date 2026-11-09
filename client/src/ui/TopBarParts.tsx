/**
 * The top bar's smaller pieces, each a plain component the bar composes: the
 * capability badges, the macro stress ticker, the live/replay toggle and the PNG
 * export button. Kept out of TopBar.tsx so each piece reads on its own.
 */

import { formatFixed } from '../i18n/format';
import { useT } from '../i18n/useT';
import { useSingleKeyShortcuts } from '../input/shortcutPrefs';
import type { StreamMode } from '../proto/types';
import type { MacroStressData } from '../state/intelligenceStore';
import {
  capabilityChipClass,
  capabilityChipLabel,
  capabilityChipTitle,
  venueGroupLabel,
  venueLabel,
  type SymbolGroupKey,
} from './symbols';
import { stressRegimeLabel } from './TopBarLabels';

interface VenueChipProps {
  market: string;
  symbol: string;
  group: SymbolGroupKey;
  chips: string[];
}

/**
 * The venue, not just its asset class: with ~106 reachable venues "Crypto" no
 * longer says WHERE the book is coming from, so a crypto session names the market
 * string (`kraken`, `binance-usdm`) it is actually subscribed to. Equity / sim
 * keep their group word — there the group IS the venue.
 */
export function VenueChip({ market, symbol, group, chips }: VenueChipProps) {
  const t = useT();
  return (
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
  );
}

interface TopBarStatusProps {
  status: string;
  /** The translated connection word (raw transport tokens never reach the screen). */
  statusText: string;
  /** The translated feed word, or '' while the feed is live. */
  feedLabel: string;
  /** A refused Replay toggle (this symbol has no recording). */
  replayUnavailable: boolean;
  /** The recorder stopped saving new data for this session. */
  recordingDegraded: boolean;
}

/**
 * The connection status, then the replay and recorder chips beside it. The status
 * is the live region; the chips are not, since the app notice stack announces the
 * full sentence once.
 */
export function TopBarStatus({ status, statusText, feedLabel, replayUnavailable, recordingDegraded }: TopBarStatusProps) {
  const t = useT();
  const feedSuffix = feedLabel ? ` · ${feedLabel}` : '';
  return (
    <>
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
    </>
  );
}

interface CapabilityBadgesProps {
  /** True before the Hello frame: capabilities are not loaded yet. */
  pending: boolean;
  chips: string[];
}

/** The honest capability chips, or a placeholder while they are still loading. */
export function CapabilityBadges({ pending, chips }: CapabilityBadgesProps) {
  const t = useT();
  return (
    <span className="caps" data-testid="capability-badges">
      {pending ? (
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
  );
}

/** The macro stress ticker (SOFR, HY OAS, the 10Y-2Y curve and the stress regime). */
export function MacroTicker({ macro }: { macro: MacroStressData | null }) {
  const t = useT();
  return (
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
      <span className={`macro-ticker__badge is-${macro?.stressRegime.toLowerCase() ?? 'unavailable'}`}>
        {macro ? stressRegimeLabel(macro.stressRegime, t) : t('topbar.unavailable')}
      </span>
    </div>
  );
}

interface ModeToggleProps {
  mode: StreamMode;
  /** The server advertises replay: only then does the Replay button exist. */
  replayAvailable: boolean;
  onSetMode: (mode: StreamMode) => void;
}

/** Live / Replay segmented control. */
export function ModeToggle({ mode, replayAvailable, onSetMode }: ModeToggleProps) {
  const t = useT();
  return (
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
      {replayAvailable && (
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
  );
}

/** Export the chart as a PNG. The bare `E` hint names the key only with single-key shortcuts on. */
export function ExportPngButton({ onExportPng }: { onExportPng: () => void }) {
  const t = useT();
  const singleKeys = useSingleKeyShortcuts();
  return (
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
  );
}
