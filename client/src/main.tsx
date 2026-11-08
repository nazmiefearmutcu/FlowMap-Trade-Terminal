import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/theme.css';
import './theme/themes.css'; // theme blocks (AFTER ui/theme.css)
import './App.css';

import { initLocale, t } from './i18n';
import { initTheme } from './theme';
import { loadSettings } from './ui/settings';
import { safeLocalStorage } from './state/safeStorage';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('FlowMap: #root element not found');
}

/**
 * Failures outside React's render tree (socket handlers, pollers, history
 * splices) never reach ErrorBoundary. They go to the console and, rate-limited,
 * to the shell toast channel, so a partly updated chart is not silent.
 */
let lastBackgroundReportAt = 0;
function reportBackgroundError(err: unknown): void {
  console.error('[flowmap] unhandled error', err);
  const now = Date.now();
  if (now - lastBackgroundReportAt < 5_000) return;
  lastBackgroundReportAt = now;
  window.__flowmapToast?.(t('app.backgroundError'));
}
window.addEventListener('error', (e) => {
  if (e.error !== undefined && e.error !== null) reportBackgroundError(e.error);
});
window.addEventListener('unhandledrejection', (e) => reportBackgroundError(e.reason));

// Boot seeders: stamp the persisted theme onto <html data-theme> and restore the
// persisted locale before the first React render, so the app's first frame uses
// the user's theme and language. A deferred module can run after the first paint,
// so that paint is governed by the static markup in index.html. Idempotent.
initTheme();
initLocale();

// Seed the persisted family before the first React render.
document.documentElement.dataset.chartRamp = loadSettings(safeLocalStorage()).colormap;

/**
 * The app module is imported lazily: its import graph evaluates the wire decoder,
 * which refuses to load on a WebView without lossless-JSON support (older
 * WKWebView / WebKitGTK). A static import would fail before anything renders and
 * leave a blank window; here the failure becomes a plain message instead.
 */
void import('./App')
  .then(({ App }) => {
    createRoot(rootEl).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  })
  .catch((err: unknown) => {
    console.error('[flowmap] the app failed to load', err);
    rootEl.textContent = t('app.startFailed');
  });
