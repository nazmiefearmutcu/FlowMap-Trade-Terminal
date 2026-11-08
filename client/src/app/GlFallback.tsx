import { useT } from '../i18n/useT';
import type { CopyState } from '../ui/ChartStartupGate';

interface GlFallbackProps {
  /** The renderer failure, shown under "technical details". */
  failure: string;
  onRetry: () => void;
  copyState: CopyState;
  onCopyDiagnostics: () => void;
}

/**
 * The chart's fallback when WebGL2 cannot render. The DOM panels (ladder, tape,
 * search) still work, so this explains what happened and offers a retry and a
 * diagnostics copy instead of leaving a blank stage.
 */
export function GlFallback({ failure, onRetry, copyState, onCopyDiagnostics }: GlFallbackProps): JSX.Element {
  const t = useT();
  return (
    <div className="gl-fallback" role="alert" data-testid="gl-fallback">
      <span className="gl-fallback__title">{t('gl.fallbackTitle')}</span>
      <span className="gl-fallback__body">{t('gl.fallbackBody')}</span>
      <details className="gl-fallback__details">
        <summary>{t('chartStartup.technicalDetails')}</summary>
        <pre className="gl-fallback__technical">{failure}</pre>
      </details>
      <span className="gl-fallback__actions">
        <button type="button" className="gl-fallback__btn" onClick={onRetry}>
          {t('gl.retry')}
        </button>
        <button type="button" className="gl-fallback__btn" onClick={onCopyDiagnostics}>
          {t('gl.copyDiagnostics')}
        </button>
      </span>
      <span className="gl-fallback__copy-state" role="status" aria-live="polite" data-testid="gl-copy-state">
        {copyState === 'copied' ? t('chartStartup.diagnosticsCopied')
          : copyState === 'failed' ? t('chartStartup.diagnosticsCopyFailed') : ''}
      </span>
    </div>
  );
}
