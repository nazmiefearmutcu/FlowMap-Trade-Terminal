/**
 * About and legal dialog, opened from the settings drawer. It states the version,
 * the licence and the bundled font licences, the data-source attribution, the
 * delay and availability caveat, and the not-investment-advice statement. In the
 * desktop shell it also offers the engine log folder so a user can attach a log
 * to a bug report.
 *
 * Modal contract matches ShortcutsOverlay: a portal, role=dialog + aria-modal,
 * focus moves in on open and returns to the opener on close, Tab is trapped, and
 * Escape closes only while this dialog is the topmost overlay.
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { version as APP_VERSION } from '../../package.json';
import { useT } from '../i18n/useT';
import { inDesktopShell, openLogFolder } from '../net/sidecarStatus';
import { FONT_LICENSES } from '../theme/fontLicenses';
import { isTopOverlay, pushOverlay } from './overlayStack';
import './About.css';

/**
 * Attribution for the providers this build contacts (README, "Data sources"). The
 * macro, dark-pool, politics, aviation, contract and job-board feeds have no
 * producer in this build, so their providers are not listed.
 */
export const DATA_SOURCES =
  'Binance, Bybit, Coinbase, Deribit, OKX (and CCXT venues), Yahoo Finance, Google Finance';

/** Licence of the FlowMap source code (see the LICENSE file). */
export const APP_LICENSE = 'Apache-2.0';

/** Public source repository. Its LICENSE and NOTICE files hold the full texts. */
export const REPO_URL = 'https://github.com/nazmiefearmutcu/flowmap';

/**
 * The short commit the build came from, or '' for a local build. The release build
 * sets VITE_BUILD_COMMIT (Vite passes VITE_ variables to the client); anything that
 * is not a git object name is ignored rather than printed.
 */
export function buildCommitOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const commit = raw.trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 12) : '';
}

/** True when the element sits inside a collapsed <details> body, so it is not on screen. */
function isInClosedDetails(el: HTMLElement): boolean {
  const details = el.closest('details');
  return details !== null && !details.open && el.closest('summary') === null;
}

interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [logState, setLogState] = useState<'idle' | 'opened' | 'failed'>('idle');
  const inShell = inDesktopShell();
  const buildCommit = buildCommitOf(import.meta.env.VITE_BUILD_COMMIT);
  // The desktop shell has no external-link handler, so there the address is plain text.
  const repoRef = inShell ? (
    <code className="about__code">{REPO_URL}</code>
  ) : (
    <a className="about__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
      {REPO_URL}
    </a>
  );

  // Joins the open-overlay registry so one Escape closes only the topmost surface.
  useEffect(() => pushOverlay('about'), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (isTopOverlay('about')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Modal focus: capture the opener, move focus inside, restore it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onTrapKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !isInClosedDetails(el));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onOpenLogs = (): void => {
    void openLogFolder().then((ok) => setLogState(ok ? 'opened' : 'failed'));
  };

  return createPortal(
    <div
      className="about__backdrop"
      data-testid="about-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        data-testid="about-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onTrapKeyDown}
      >
        <header className="about__head">
          <h2 className="about__title" id="about-title">{t('about.title')}</h2>
          <button
            ref={closeRef}
            type="button"
            className="about__close"
            onClick={onClose}
            data-testid="about-close"
            aria-label={t('about.close')}
          >
            ✕
          </button>
        </header>

        <div className="about__body">
          <p className="about__version" data-testid="about-version">
            {t('about.version', { version: APP_VERSION })}
          </p>
          {buildCommit !== '' && (
            <p className="about__version" data-testid="about-build">{t('about.build', { commit: buildCommit })}</p>
          )}
          <p>{t('about.license', { license: APP_LICENSE })}</p>
          <p>{t('about.licenseFiles')}</p>
          <p className="about__source" data-testid="about-source">{t('about.sourceCode')} {repoRef}</p>

          <section className="about__section" aria-labelledby="about-advice-title">
            <h3 className="about__heading" id="about-advice-title">{t('about.adviceTitle')}</h3>
            <p data-testid="about-not-advice">{t('about.notAdvice')}</p>
          </section>

          <section className="about__section" aria-labelledby="about-data-title">
            <h3 className="about__heading" id="about-data-title">{t('about.dataTitle')}</h3>
            <p>{t('about.delay')}</p>
          </section>

          <section className="about__section" aria-labelledby="about-sources-title">
            <h3 className="about__heading" id="about-sources-title">{t('about.sourcesTitle')}</h3>
            <p data-testid="about-sources">{t('about.sourcesBody', { sources: DATA_SOURCES })}</p>
            <p>{t('about.sourcesTerms')}</p>
          </section>

          {inShell && (
            <section className="about__section" aria-labelledby="about-logs-title">
              <h3 className="about__heading" id="about-logs-title">{t('about.logsTitle')}</h3>
              <p>{t('about.logsHint')}</p>
              <button type="button" className="about__action" onClick={onOpenLogs} data-testid="about-open-logs">
                {t('about.openLogs')}
              </button>
              <span className="about__status" role="status" aria-live="polite" data-testid="about-logs-state">
                {logState === 'opened' ? t('about.openLogsDone') : logState === 'failed' ? t('about.openLogsFailed') : ''}
              </span>
            </section>
          )}

          <div className="about__section">
            <details className="about__fonts" data-testid="about-fonts">
              <summary className="about__summary">{t('about.fontsTitle')}</summary>
              {FONT_LICENSES.map((font, index) => (
                <div className="about__font" key={font.family}>
                  <h4 className="about__heading">{font.family}</h4>
                  <p id={`about-font-licence-${index}`}>{t('about.fontLicence', { license: font.license })}</p>
                  <pre className="about__licence-text" role="region" tabIndex={0} aria-labelledby={`about-font-licence-${index}`}>
                    {font.text}
                  </pre>
                </div>
              ))}
            </details>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
