import { useEffect, useState, type RefObject } from 'react';
import { useT } from '../i18n/useT';
import { sessionResetKey, useFlowMapStore } from '../state/store';
import './ChartStartupGate.css';

interface ChartPresentation {
  readonly marketFrameReady: boolean;
  residentRange?: () => { readonly count: number } | null;
  /** Renderer.getRenderFailure: why the last frame failed, or null while frames render. */
  getRenderFailure?: () => string | null;
}

interface ChartStartupGateProps {
  rendererRef: RefObject<ChartPresentation | null>;
  disabled?: boolean;
  /**
   * Re-create the renderer or re-arm its frame loop. The failure view offers
   * Retry only when this is supplied; the gate waits for a fresh presentation
   * after it either way.
   */
  onRetry?: () => void;
  /**
   * Subscribe again to an instrument, the same path a symbol pick takes. The
   * empty-history view offers it as its retry control.
   */
  onResubscribe?: (market: string, symbol: string) => void;
  /** Open the symbol search, so the user can pick another instrument. */
  onSearchSymbols?: () => void;
  /**
   * The desktop engine has stopped and did not restart. The failed-engine notice
   * above the gate carries the Retry, so the gate names the state rather than
   * saying the chart is still connecting.
   */
  engineFailed?: boolean;
}

export interface ChartDiagnosticsInput {
  readonly failure: string;
  readonly connection: string;
  readonly feed: string;
  readonly sessionId: string | null;
  readonly instrument: string | null;
  readonly now: Date;
  readonly userAgent: string;
}

/**
 * Plain-text diagnostics for a bug report. Carries no credentials: the session
 * token is never in the store, and the session id is an opaque label.
 */
export function chartDiagnosticsText(input: ChartDiagnosticsInput): string {
  return [
    'FlowMap chart diagnostics',
    `time: ${input.now.toISOString()}`,
    `render failure: ${input.failure}`,
    `connection: ${input.connection}`,
    `feed: ${input.feed}`,
    `session: ${input.sessionId ?? 'none'}`,
    `instrument: ${input.instrument ?? 'none'}`,
    `user agent: ${input.userAgent}`,
  ].join('\n');
}

export type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Copy the plain-text chart diagnostics to the clipboard. The promise rejects when
 * the clipboard refuses, so the caller can say so.
 */
export async function copyChartDiagnostics(report: { failure: string; instrument: string | null }): Promise<void> {
  const state = useFlowMapStore.getState();
  const text = chartDiagnosticsText({
    failure: report.failure,
    connection: state.status,
    feed: state.feedState ?? 'unknown',
    sessionId: state.sessionId,
    instrument: report.instrument,
    now: new Date(),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  });
  await navigator.clipboard.writeText(text);
}

/** How long one failing frame run must persist before the failure view replaces the chart. */
const FAILURE_HOLD_MS = 1500;

/** Reveal an actual market after consecutive successful presentations.
 * Canvases continue drawing below this grid overlay throughout initialization.
 * A reconnect retains an already presented history view; a new source or a
 * lost graphics context waits for its own first successful market frame.
 * A renderer that reports a persistent frame failure gets its own visible
 * state (Retry and Copy diagnostics) instead of "Preparing chart" forever.
 */
export function ChartStartupGate({
  rendererRef, disabled = false, onRetry, onResubscribe, onSearchSymbols, engineFailed = false,
}: ChartStartupGateProps): JSX.Element | null {
  const t = useT();
  const sub = useFlowMapStore(s => s.subscription);
  const sessionId = useFlowMapStore(s => s.sessionId);
  const revision = useFlowMapStore(s => s.sessionRevision);
  const status = useFlowMapStore(s => s.status);
  const feedState = useFlowMapStore(s => s.feedState);
  const noFeed = useFlowMapStore(s => s.noFeed);
  const retryConnection = useFlowMapStore(s => s.retryNow);
  const identity = `${sessionResetKey(sub)}:${sub?.mode ?? ''}:${sessionId ?? ''}:${revision}`;
  const [revealedIdentity, setRevealedIdentity] = useState<string | null>(null);
  const [emptyHistoryIdentity, setEmptyHistoryIdentity] = useState<string | null>(null);
  const [renderFailure, setRenderFailure] = useState<string | null>(null);

  useEffect(() => {
    if (disabled) return;
    setRevealedIdentity(null);
    setEmptyHistoryIdentity(null);
    let raf = 0;
    let presentedFrames = 0;
    let revealed = false;
    let hadResidentHistory = false;
    let emptyHistory = false;
    // undefined forces the first frame to publish whatever the renderer reports.
    let lastFailure: string | null | undefined;
    // When the current run of failing frames began (frame timestamp), or null.
    let failingSince: number | null = null;
    const frame = (timestamp: number): void => {
      const renderer = rendererRef.current;
      const state = useFlowMapStore.getState();
      const failure = renderer?.getRenderFailure?.() ?? null;
      // A single bad frame is not a failure: the view appears only once the same
      // failure has persisted for FAILURE_HOLD_MS, matching the App fallback.
      if (failure === null) failingSince = null;
      else failingSince ??= timestamp;
      const shown = failure !== null && failingSince !== null && timestamp - failingSince >= FAILURE_HOLD_MS
        ? failure : null;
      if (shown !== lastFailure) {
        lastFailure = shown;
        setRenderFailure(shown);
      }
      const range = renderer?.residentRange?.();
      hadResidentHistory ||= (range?.count ?? 0) > 0;
      // An attached closed feed with no retained history is a result, not an
      // endless load. Unknown presentation APIs and a GPU rebuild after real
      // history was retained must not be mistaken for provider data absence.
      const empty = typeof renderer?.residentRange === 'function' && !hadResidentHistory
        && (range?.count ?? 0) === 0 && state.status === 'live'
        && state.feedState === 'closed' && state.sessionId !== null && !state.noFeed;
      if (empty !== emptyHistory) {
        emptyHistory = empty;
        setEmptyHistoryIdentity(empty ? identity : null);
      }
      const presented = renderer?.marketFrameReady === true;
      if (!presented) {
        presentedFrames = 0;
        if (revealed) {
          revealed = false;
          setRevealedIdentity(null);
        }
      } else if (!revealed) {
        // A closed market or reconnect can still present real recorded data.
        // The renderer verifies its source; transport badges remain visible.
        const connected = state.sessionId !== null && !state.noFeed;
        // Readiness is independent of refresh rate. Requiring a 40ms interval
        // leaves a correctly drawn chart covered forever on a slow display.
        presentedFrames = connected ? presentedFrames + 1 : 0;
        if (presentedFrames >= 4) {
          revealed = true;
          setRevealedIdentity(identity);
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [disabled, identity, rendererRef]);

  if (disabled) return null;
  if (renderFailure !== null) {
    return (
      <ChartFailure
        failure={renderFailure}
        instrument={sub ? `${sub.market}:${sub.symbol}` : null}
        onRetry={onRetry}
      />
    );
  }
  if (revealedIdentity === identity) return null;
  const historyUnavailable = emptyHistoryIdentity === identity;
  // The no-feed sentence itself is shown once, by the closed banner; the gate
  // names the state and offers the way out.
  const label = engineFailed ? t('sidecar.failedTitle')
    : noFeed ? t('banner.noFeed')
    : historyUnavailable ? t('chartStartup.historyUnavailable') : feedState === 'closed' ? t('banner.closed')
    : status === 'reconnecting' || feedState === 'reconnecting' ? t('banner.reconnecting')
    : status === 'closed' ? t('chartStartup.disconnected')
    : status !== 'live' ? t('chartStartup.connecting') : t('chartStartup.preparing');
  const retryable = historyUnavailable && sub !== null && onResubscribe !== undefined;
  const offersSearch = (historyUnavailable || noFeed) && onSearchSymbols !== undefined;
  // The reconnect banner sits beneath this gate, so the gate carries the same
  // retry-now action while the socket is reconnecting.
  const offersReconnect = status === 'reconnecting' && !engineFailed;
  return (
    <div className="chart-startup" role="status" aria-live="polite" data-testid="chart-startup-gate">
      <div className="chart-startup__message">
        {!historyUnavailable && <span className="chart-startup__mark" aria-hidden="true" />}
        <strong>{label}</strong>
        {historyUnavailable && <span className="chart-startup__detail">{t('chartStartup.historyUnavailableDetail')}</span>}
        {noFeed && <span className="chart-startup__detail">{t('chartStartup.noFeedHint')}</span>}
        {sub && <span className="chart-startup__instrument">{sub.symbol} <span>{sub.market}</span></span>}
        {(retryable || offersSearch || offersReconnect) && (
          <div className="chart-startup__actions">
            {retryable && (
              <button
                type="button"
                className="chart-startup__button"
                onClick={() => { if (sub && onResubscribe) onResubscribe(sub.market, sub.symbol); }}
                data-testid="chart-startup-resubscribe"
              >
                {t('chartStartup.retry')}
              </button>
            )}
            {offersReconnect && (
              <button
                type="button"
                className="chart-startup__button"
                onClick={() => retryConnection()}
                data-testid="chart-startup-reconnect"
              >
                {t('banner.retryNow')}
              </button>
            )}
            {offersSearch && (
              <button
                type="button"
                className="chart-startup__button"
                onClick={onSearchSymbols}
                data-testid="chart-startup-search"
              >
                {t('search.openAria')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** The chart graphics failed to draw: say so, offer Retry, and keep diagnostics copyable. */
function ChartFailure({ failure, instrument, onRetry }: {
  failure: string;
  instrument: string | null;
  onRetry: (() => void) | undefined;
}): JSX.Element {
  const t = useT();
  const [copyState, setCopyState] = useState<CopyState>('idle');

  const copyDiagnostics = async (): Promise<void> => {
    try {
      await copyChartDiagnostics({ failure, instrument });
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <div className="chart-startup chart-startup--failed" role="alert" data-testid="chart-startup-failed">
      <div className="chart-startup__message">
        <strong className="chart-startup__failure-title">{t('chartStartup.couldNotStart')}</strong>
        <span className="chart-startup__detail">{t('chartStartup.couldNotStartDetail')}</span>
        <details className="chart-startup__technical">
          <summary>{t('chartStartup.technicalDetails')}</summary>
          <pre className="chart-startup__technical-text">{failure}</pre>
        </details>
        <div className="chart-startup__actions">
          {onRetry && (
            <button type="button" className="chart-startup__button" onClick={onRetry} data-testid="chart-startup-retry">
              {t('chartStartup.retry')}
            </button>
          )}
          <button
            type="button"
            className="chart-startup__button"
            onClick={() => { void copyDiagnostics(); }}
            data-testid="chart-startup-copy"
          >
            {t('chartStartup.copyDiagnostics')}
          </button>
        </div>
        <span className="chart-startup__copy-state" aria-live="polite" data-testid="chart-startup-copy-state">
          {copyState === 'copied' ? t('chartStartup.diagnosticsCopied')
            : copyState === 'failed' ? t('chartStartup.diagnosticsCopyFailed') : ''}
        </span>
      </div>
    </div>
  );
}
