/**
 * Root error boundary. An uncaught throw inside a mount effect (or any render)
 * unmounts React's entire tree — the user sees a bare background-color void
 * with no message and no way out. This boundary guarantees the failure is at
 * least LEGIBLE: what broke, the technical detail behind a disclosure (copyable
 * for a bug report), and a reload action.
 *
 * It is deliberately not a boundary for individual panels: a panel-level
 * boundary that re-renders into a broken frame does more harm than good. One
 * boundary at the root converts "blank screen" into "error card".
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  copy: 'idle' | 'copied' | 'failed';
}

/** The text a bug report needs: the message, then the stack when there is one. */
export function errorDetailsText(error: Error): string {
  return error.stack && error.stack.includes(error.message)
    ? error.stack
    : `${error.message}${error.stack ? `\n\n${error.stack}` : ''}`;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, copy: 'idle' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, copy: 'idle' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the failure on the console for anyone with devtools open; the UI
    // below is the user-facing half of the report.
    console.error('[flowmap] unrecoverable UI error', error, info.componentStack);
  }

  private readonly copyDetails = async (): Promise<void> => {
    const { error } = this.state;
    if (!error) return;
    try {
      await navigator.clipboard.writeText(errorDetailsText(error));
      this.setState({ copy: 'copied' });
    } catch {
      this.setState({ copy: 'failed' });
    }
  };

  render(): ReactNode {
    const { error, copy } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash" role="alert" data-testid="app-crash">
        <span className="app-crash__title">{t('error.title')}</span>
        <details className="app-crash__disclosure">
          <summary>{t('error.detail')}</summary>
          <pre className="app-crash__detail">{error.message}</pre>
        </details>
        <div className="app-crash__actions">
          <button type="button" className="app-crash__copy" onClick={() => { void this.copyDetails(); }} data-testid="app-crash-copy">
            {t('error.copy')}
          </button>
          <button type="button" className="app-crash__reload" onClick={() => window.location.reload()}>
            {t('error.reload')}
          </button>
        </div>
        <span className="app-crash__copy-state" aria-live="polite" data-testid="app-crash-copy-state">
          {copy === 'copied' ? t('error.copied') : copy === 'failed' ? t('error.copyFailed') : ''}
        </span>
      </div>
    );
  }
}
