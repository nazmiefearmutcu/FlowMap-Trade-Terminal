import { useT } from '../i18n/useT';
import { inDesktopShell } from '../net/sidecarStatus';
import type { EngineStatus } from './useEngineStatus';

interface AppNoticeStackProps {
  engine: EngineStatus;
  /** The server's recording writer is stalled. */
  recordingDegraded: boolean;
  /** The server's market overview is running behind its deadline. */
  overviewDegraded: boolean;
  /** The chart shows the simulated feed. */
  simActive: boolean;
}

/**
 * The notices pinned over the chart: a failed desktop engine (with retry and
 * open-log actions), a stalled recording, a lagging market overview, and the
 * simulated-feed badge.
 */
export function AppNoticeStack({ engine, recordingDegraded, overviewDegraded, simActive }: AppNoticeStackProps): JSX.Element {
  const t = useT();
  const { sidecar, logOpen, onRetrySidecar, onOpenLogFolder } = engine;
  return (
    <div className="app-notices">
      {sidecar?.state === 'failed' && (
        <div className="app-notice app-notice--fatal" role="alert" data-testid="sidecar-failed">
          <strong>{t('sidecar.failedTitle')}</strong>
          <span>
            {t('sidecar.failedBody')}
            {sidecar.logPath !== null && <code> {sidecar.logPath}</code>}
          </span>
          <button type="button" title={t('sidecar.retryHint')} onClick={onRetrySidecar}>
            {t('sidecar.retry')}
          </button>
          {inDesktopShell() && (
            <button type="button" onClick={onOpenLogFolder} data-testid="sidecar-open-logs">
              {t('sidecar.openLog')}
            </button>
          )}
          {logOpen === 'failed' && (
            <span role="status" data-testid="sidecar-open-logs-failed">{t('sidecar.openLogFailed')}</span>
          )}
        </div>
      )}
      {recordingDegraded && (
        <div className="app-notice" role="status" data-testid="recording-degraded">
          <span>{t('banner.recordingDegraded')}</span>
        </div>
      )}
      {overviewDegraded && (
        <div className="app-notice" role="status" data-testid="overview-degraded">
          <span>{t('banner.overviewDegraded')}</span>
        </div>
      )}
      {simActive && (
        <span className="app-notice app-notice--sim" data-testid="sim-badge">{t('app.simBadge')}</span>
      )}
    </div>
  );
}
