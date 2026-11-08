/**
 * Reconnect banner — a slim, truthful overlay for the one status that was
 * previously only readable in the top-bar chip: the socket is DOWN and a
 * reconnect attempt is in flight. Renders ONLY when the store's connection
 * status is literally `reconnecting` — never speculatively — and names the
 * market:symbol it is trying to reach, HOW the last socket closed (the
 * transport's close info, spelled as one calm human line), and which attempt
 * this is. The "retry now" button skips the remaining backoff by re-entering
 * the connection's own reconnect path. `role="status"` + `aria-live="polite"`
 * so the transition into (and out of) the state is announced.
 *
 * Two terminal states replace it, with `role="alert"` and no retry control:
 * a wire-version mismatch (the connection parks) and a subscription the server
 * refused for good. Retrying cannot fix either, so the banner says so.
 */

import { t } from '../i18n';
import { useT } from '../i18n/useT';
import type { CloseInfo } from '../net/connection';
import { refusalReasonKey } from '../net/refusalReason';
import { useFlowMapStore } from '../state/store';

/** Attempts after which the banner says the reconnect is failing, not merely retrying. */
export const ESCALATE_AFTER_ATTEMPTS = 8;

/**
 * Short human text for how the last socket closed. Pure — unit-tested. An
 * unknown/absent code reads as the transport death it is; codes the server
 * actually sends get their real meaning (1001 sidecar shutdown, 1013 refused
 * for load) instead of a raw number dump.
 */
export function closeReasonText(close: CloseInfo | null): string {
  // Every mapped reason goes through a shared banner key (module-level `t`).
  if (!close) return t('banner.reasonDropped');
  switch (close.code) {
    case 1000:
      return t('banner.reasonSession');
    case 1001:
      return t('banner.reasonShutdown');
    case 1002:
      return t('banner.reason1002');
    case 1003:
      return t('banner.reason1003');
    case 1013:
      return t('banner.reasonOverloaded');
    case null:
    case 1006:
      return t('banner.reasonDropped');
    default:
      return close.wasClean
        ? t('banner.reasonCode', { code: close.code })
        : t('banner.reasonDropped');
  }
}

export function ReconnectBanner(): JSX.Element | null {
  useT(); // re-render on locale change
  const status = useFlowMapStore((s) => s.status);
  const subscription = useFlowMapStore((s) => s.subscription);
  const lastClose = useFlowMapStore((s) => s.lastClose);
  const attempts = useFlowMapStore((s) => s.reconnectAttempts);
  const retryNow = useFlowMapStore((s) => s.retryNow);
  const protocolMismatch = useFlowMapStore((s) => s.protocolMismatch);
  const refusal = useFlowMapStore((s) => s.refusal);
  // Terminal states come first: retrying cannot fix a wire-version mismatch or
  // a refused subscription, so neither shows the retry control or reconnect copy.
  if (protocolMismatch) {
    return (
      <div className="reconnect-banner reconnect-banner--fatal" role="alert" data-testid="protocol-mismatch-banner">
        <span className="reconnect-banner__text">
          {t('banner.protocolMismatch', { got: protocolMismatch.got, expected: protocolMismatch.expected })}
        </span>
      </div>
    );
  }
  if (refusal) {
    // The server's refusal token is never shown raw: a known token reads as its
    // translated reason, an unknown one as the generic "unrecognized reason", and
    // a refusal with no token as the plain refusal copy.
    const reasonKey = refusalReasonKey(refusal.reason);
    return (
      <div className="reconnect-banner reconnect-banner--fatal" role="alert" data-testid="refusal-banner">
        <span className="reconnect-banner__text">
          {reasonKey !== null
            ? t('banner.refusedWithReason', { reason: t(reasonKey) })
            : t('banner.refused')}
        </span>
      </div>
    );
  }
  if (status !== 'reconnecting') return null;
  const target = subscription ? `${subscription.market}:${subscription.symbol}` : t('banner.theFeed');
  const attemptText = attempts >= ESCALATE_AFTER_ATTEMPTS
    ? t('banner.stillFailing', { attempts })
    : t('banner.attempt', { attempts });
  return (
    <div
      className="reconnect-banner"
      role="status"
      aria-live="polite"
      data-testid="reconnect-banner"
    >
      <span className="reconnect-banner__dot" aria-hidden="true" />
      <span className="reconnect-banner__text">
        {t('banner.lostReconnecting', { target, reason: closeReasonText(lastClose) })}
        {attempts > 0 ? ` · ${attemptText}` : ''}
      </span>
      <button
        type="button"
        className="reconnect-banner__retry"
        onClick={retryNow}
        data-testid="reconnect-retry"
        title={t('banner.retryNowHint')}
      >
        {t('banner.retryNow')}
      </button>
    </div>
  );
}
