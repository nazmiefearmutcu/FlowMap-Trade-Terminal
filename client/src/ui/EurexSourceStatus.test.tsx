import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { EurexSourceStatus } from './EurexSourceStatus';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => setLocale('en'));

describe('official Eurex status', () => {
  it.each(['en', 'tr'] as const)('shows source, delay, incomplete coverage and unknown session in %s', locale => {
    setLocale(locale);
    const div = document.createElement('div');
    const root = createRoot(div);
    act(() => root.render(<EurexSourceStatus capability={{ source: 'eurex_delayed_posttrade',
      status: 'partial', latest_event_ns: '1794564000000000000', last_success_ns: null, pending_files: 12 }} />));
    expect(div.textContent).toContain(locale === 'tr' ? '15 dk gecikmeli' : '15 min delayed');
    expect(div.textContent).toContain(locale === 'tr' ? 'Kapsam eksik' : 'Incomplete coverage');
    expect(div.textContent).toContain(locale === 'tr' ? 'Seans bilinmiyor' : 'Session unknown');
    expect(div.querySelector('span')?.title).toContain('12');
    // The publisher's terms travel with the source.
    expect(div.querySelector('span')?.title).toContain(locale === 'tr' ? 'yalnızca araştırma amaçlı' : 'research use only');
    expect(div.querySelector('span')?.title).toContain('mfs.deutsche-boerse.com/DEUR-posttrade');
    act(() => root.unmount());
  });

  it('does not claim a sync while nothing is being collected', () => {
    const div = document.createElement('div');
    const root = createRoot(div);
    act(() => root.render(<EurexSourceStatus capability={{ source: 'eurex_delayed_posttrade',
      status: 'idle', collecting: false }} />));
    expect(div.textContent).not.toContain('Syncing');
    act(() => root.render(<EurexSourceStatus capability={{ source: 'eurex_delayed_posttrade',
      status: 'partial', collecting: true }} />));
    expect(div.textContent).toContain('Syncing history');
    act(() => root.unmount());
  });
});
