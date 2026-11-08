import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTimeZonePref, zonedWallText, zonedWallToNs } from '../i18n/format';
import { ReplayPicker, utcDateTime, utcDateTimeNs } from './ReplayPicker';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const T0 = 1_791_900_000_123_000_000n;
const availability = { hours: [(T0 / 3_600_000_000_000n * 3_600_000_000_000n).toString()],
  latest_column_ns: T0.toString(), max_columns: 4096 };
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const button = (text: string): HTMLButtonElement => Array.from(document.querySelectorAll('button'))
  .find((b) => b.textContent === text)!;
async function mount(onClose = vi.fn(), onConfirm = vi.fn(), market = 'binance-spot'): Promise<void> {
  container = document.createElement('div'); document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<ReplayPicker market={market} symbol="BTCUSDT" onClose={onClose} onConfirm={onConfirm} />);
  });
}
// The suites below pin the picker to UTC unless a test says otherwise.
beforeEach(() => setTimeZonePref('utc'));
afterEach(() => {
  act(() => root?.unmount()); root = null; container?.remove(); container = null;
  document.body.replaceChildren(); vi.unstubAllGlobals(); setTimeZonePref('local');
});
describe('ReplayPicker', () => {
  it('defaults to the latest short interval, shows zone/buckets and confirms only a checked bounded range', async () => {
    const confirm = vi.fn();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(availability )})
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(({ start_ns: (T0 - 120_000_000_000n).toString(),
        end_ns: (T0 + 250_000_000n).toString(), columns: 481 }) )});
    vi.stubGlobal('fetch', fetch);
    await mount(vi.fn(), confirm);
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    expect(utcDateTimeNs(inputs[0].value)).toBe(T0 - 300_000_000_000n);
    expect(utcDateTimeNs(inputs[1].value)).toBe(T0 + 1_000_000_000n);
    expect(document.body.textContent).toContain('Time zone:');
    expect(document.body.textContent).toContain('gaps may exist');
    expect(button('Open paused')).toBeUndefined();
    await act(async () => button('Check interval').click());
    expect(fetch.mock.calls[0][0]).toContain('availability?market=binance-spot&symbol=BTCUSDT');
    expect(fetch.mock.calls[1][0]).toContain(`start_ns=${T0 - 300_000_000_000n}&end_ns=${T0 + 1_000_000_000n}`);
    expect(document.body.textContent).toContain('481 recorded columns');
    expect(document.body.textContent).toContain('quotes use recorded row centres');
    act(() => button('Open paused').click());
    expect(confirm).toHaveBeenCalledWith(T0 - 300_000_000_000n, T0 + 1_000_000_000n);
  });
  it.each(['replay window exceeds 4096 columns; choose a shorter interval', 'no recorded columns in selected interval'])(
    'keeps the stream untouched and shows a localized selection error, never the raw server detail: %s', async (detail) => {
      const confirm = vi.fn();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(availability )})
        .mockResolvedValueOnce({ ok: false, status: 422, text: async () => JSON.stringify(({ detail }) )}));
      await mount(vi.fn(), confirm);
      await act(async () => button('Check interval').click());
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('cannot be replayed');
      expect(document.querySelector('[role="alert"]')!.textContent).not.toContain(detail);
      expect(button('Open paused')).toBeUndefined(); expect(confirm).not.toHaveBeenCalled();
    });
  it('reports an HTML error page as an unreachable engine, never as a JSON parse error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500,
      text: async () => '<html><body>Internal Server Error</body></html>' }));
    await mount();
    const alert = document.querySelector('[role="alert"]');
    expect(alert!.textContent).toContain('Cannot reach the FlowMap engine');
    expect(alert!.textContent).not.toMatch(/JSON|Unexpected token|object Object|HTTP/);
  });

  it('explains a missing recording store (404) instead of showing the server text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404,
      text: async () => JSON.stringify({ detail: 'no recording store' }) }));
    await mount();
    const alert = document.querySelector('[role="alert"]')!.textContent ?? '';
    expect(alert).toContain('The engine has no recording store');
    expect(alert).not.toContain('{');
  });

  it('reports a 404 without the recording-store code as an HTTP error, not as a switched-off recorder', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404,
      text: async () => JSON.stringify({ error: { code: 'not_found', message: 'Not Found' } }) }));
    await mount();
    const alert = document.querySelector('[role="alert"]')!.textContent ?? '';
    expect(alert).toContain('HTTP 404');
    expect(alert).not.toContain('no recording store');
  });

  it('explains a recording store that is missing when the server names that code', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404,
      text: async () => JSON.stringify({ error: { code: 'recording_store_missing', message: 'no recording store is configured' } }) }));
    await mount();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('The engine has no recording store');
  });

  it('reads a coded 422 replay_unavailable as a rejected interval', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(availability) })
      .mockResolvedValueOnce({ ok: false, status: 422,
        text: async () => JSON.stringify({ error: { code: 'replay_unavailable', message: 'no replayable recording covers this window' } }) }));
    await mount();
    await act(async () => button('Check interval').click());
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('cannot be replayed');
  });

  it('says recording is turned off, not that no recordings exist, when /api/health reports it disabled', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ ...availability, hours: [], latest_column_ns: null }) })
      .mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify({ recording_enabled: false }) });
    vi.stubGlobal('fetch', fetch);
    await mount();
    expect(document.body.textContent).toContain('Recording is turned off');
    expect(document.body.textContent).not.toContain('No recordings for this instrument.');
    expect(fetch.mock.calls[1][0]).toContain('/api/health');
  });

  it('shows no recording and closes with Escape while restoring opener focus', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(({ ...availability, hours: [], latest_column_ns: null }) )}));
    const opener = document.createElement('button'); document.body.appendChild(opener); opener.focus();
    const close = vi.fn(); await mount(close);
    expect(document.body.textContent).toContain('No recordings for this instrument.');
    expect(button('Check interval').disabled).toBe(true);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Cancel');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(close).toHaveBeenCalledOnce();
    act(() => root?.unmount()); root = null;
    expect(document.activeElement).toBe(opener);
  });
  it('traps keyboard focus within the compact dialog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(availability )}));
    await mount(); const first = document.querySelector<HTMLButtonElement>('button')!;
    const last = button('Check interval'); last.focus();
    act(() => last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    act(() => first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
  });
  it('parses manual UTC inputs strictly at millisecond precision', () => {
    expect(utcDateTimeNs(utcDateTime(T0))).toBe(T0);
    expect(utcDateTimeNs('2026-11-01T06:30')).toBe(BigInt(Date.parse('2026-11-01T06:30Z')) * 1_000_000n);
    for (const invalid of ['', 'invalid', '2026-02-30T12:00', '2026-11-01T25:00', '2026-11-01T06:30Z',
      '0000-01-01T00:00', '2026-11-01T06:30:00.0001', '2026-11-01T06:30-05:00']) {
      expect(utcDateTimeNs(invalid), invalid).toBeNull();
    }
  });
  it.each(['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z',
    '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-16T12:30:00Z'])(
    'retains exact defaults, recorded selections and presets through confirmation at %s', async (instant) => {
      // Run this real component suite in fresh NY/Berlin/Istanbul processes.
      // Deliberately retain nanoseconds that datetime-local cannot display.
      const anchor = BigInt(Date.parse(instant)) * 1_000_000n + 123_456n;
      const confirm = vi.fn();
      const fetch = vi.fn().mockImplementation(async (url: string) => {
        const params = new URL(url, 'http://localhost').searchParams;
        return { ok: true, text: async () => JSON.stringify(url.includes('/availability?') ?
          { hours: [anchor.toString()], latest_column_ns: anchor.toString(), max_columns: 4096 } :
          { start_ns: params.get('start_ns'), end_ns: params.get('end_ns'), columns: 20 } )};
      });
      vi.stubGlobal('fetch', fetch); await mount(vi.fn(), confirm);
      expect(document.querySelectorAll('label')[1].textContent).toContain('(UTC)');
      const checkAndConfirm = async (start: bigint, end: bigint): Promise<void> => {
        await act(async () => button('Check interval').click());
        expect(fetch.mock.calls.at(-1)![0]).toContain(`start_ns=${start}&end_ns=${end}`);
        act(() => button('Open paused').click());
        expect(confirm.mock.calls.at(-1)).toEqual([start, end]);
      };
      await checkAndConfirm(anchor - 300_000_000_000n, anchor + 1_000_000_000n);
      act(() => button('15 min').click());
      await checkAndConfirm(anchor + 1_000_000_000n - 900_000_000_000n, anchor + 1_000_000_000n);
      const select = document.querySelector('select')!;
      act(() => { select.value = anchor.toString(); select.dispatchEvent(new Event('change', { bubbles: true })); });
      await checkAndConfirm(anchor, anchor + 900_000_000_000n);
    });
  it('manual UTC edits invalidate preview and reject reversed/empty ranges without requesting or confirming', async () => {
    const confirm = vi.fn(), fetch = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(availability )});
    vi.stubGlobal('fetch', fetch); await mount(vi.fn(), confirm);
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const edit = (input: HTMLInputElement, value: string): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => edit(inputs[0], '2026-11-01T06:30:00.125'));
    act(() => edit(inputs[1], '2026-11-01T06:29:00.125'));
    await act(async () => button('Check interval').click());
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1); expect(confirm).not.toHaveBeenCalled();
    act(() => edit(inputs[1], ''));
    await act(async () => button('Check interval').click());
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => edit(inputs[1], '2026-11-01T06:31:00.125'));
    fetch.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(({
      start_ns: '1793514600125000000', end_ns: '1793514660125000000', columns: 20 }) )});
    await act(async () => button('Check interval').click());
    const start = BigInt(Date.parse('2026-11-01T06:30:00.125Z')) * 1_000_000n;
    expect(fetch.mock.calls.at(-1)![0]).toContain(`start_ns=${start}&end_ns=${start + 60_000_000_000n}`);
    act(() => button('Open paused').click());
    expect(confirm).toHaveBeenCalledWith(start, start + 60_000_000_000n);
    act(() => edit(inputs[0], '2026-11-01T06:30:01.125'));
    expect(button('Open paused')).toBeUndefined();
  });

  it('reads the edges and the hour list in the Settings zone and keeps the instant when the zone changes', async () => {
    const ny = 'America/New_York';
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(availability) })
      .mockResolvedValue({ ok: true, text: async () => JSON.stringify({ start_ns: '0', end_ns: '0', columns: 1 }) });
    vi.stubGlobal('fetch', fetch);
    setTimeZonePref('exchange');
    await mount(vi.fn(), vi.fn(), 'equity');
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const startMs = Number((T0 - 300_000_000_000n) / 1_000_000n);
    expect(inputs[0].value).toBe(zonedWallText(startMs, ny));
    expect(document.body.textContent).toContain('Time zone:');
    const hourLabel = zonedWallText(Number(BigInt(availability.hours[0]) / 1_000_000n), ny).slice(0, 16).replace('T', ' ');
    expect(document.querySelector('select')!.options[1].textContent).toContain(hourLabel);
    act(() => setTimeZonePref('utc'));
    expect(inputs[0].value).toBe(zonedWallText(startMs, 'UTC'));
    await act(async () => button('Check interval').click());
    expect(fetch.mock.calls.at(-1)![0]).toContain(`start_ns=${T0 - 300_000_000_000n}&end_ns=${T0 + 1_000_000_000n}`);
  });

  it('reads a typed edge in the Settings zone before it asks the engine for the window', async () => {
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(availability) })
      .mockResolvedValue({ ok: true, text: async () => JSON.stringify({ start_ns: '0', end_ns: '0', columns: 1 }) });
    vi.stubGlobal('fetch', fetch);
    setTimeZonePref('exchange');
    await mount(vi.fn(), vi.fn(), 'equity');
    const inputs = document.querySelectorAll<HTMLInputElement>('input');
    const edit = (input: HTMLInputElement, value: string): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    // 07:30 in New York in January (EST, UTC-5) is 12:30 UTC.
    act(() => edit(inputs[0], '2026-01-15T07:30:00.125'));
    act(() => edit(inputs[1], '2026-01-15T07:31:00.125'));
    await act(async () => button('Check interval').click());
    const start = BigInt(Date.UTC(2026, 0, 15, 12, 30, 0, 125)) * 1_000_000n;
    expect(fetch.mock.calls.at(-1)![0]).toContain(`start_ns=${start}&end_ns=${start + 60_000_000_000n}`);
  });

  it('uses the system zone for its edges when the Settings zone is local', async () => {
    setTimeZonePref('local');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(availability) }));
    await mount();
    const input = document.querySelector<HTMLInputElement>('input')!;
    expect(zonedWallToNs(input.value, undefined)).toBe(T0 - 300_000_000_000n);
  });
});
