import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRecordingSettings, RecordingSection } from './SettingsDrawerRecording';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
let root: Root | null = null;
let container: HTMLElement | null = null;

function installShell(invoke: Invoke): void {
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: () => 1,
  };
}

async function mount(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(<RecordingSection />);
  });
}

const toggle = (): HTMLButtonElement => document.querySelector<HTMLButtonElement>('[data-testid="toggle-recording"]')!;
const state = (): string => document.querySelector('[data-testid="setting-recording-state"]')?.textContent ?? '';
const reply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  enabled: true, capGb: 20, folder: 'C:/data/recordings', restarting: false, ...over,
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('parseRecordingSettings', () => {
  it('accepts the shell reply and rejects anything malformed', () => {
    expect(parseRecordingSettings(reply())).toEqual({ enabled: true, capGb: 20, folder: 'C:/data/recordings', restarting: false });
    expect(parseRecordingSettings(reply({ enabled: 'yes' }))).toBeNull();
    expect(parseRecordingSettings(reply({ capGb: Number.NaN }))).toBeNull();
    expect(parseRecordingSettings(reply({ folder: 3 }))).toBeNull();
    expect(parseRecordingSettings(null)).toBeNull();
  });
});

describe('RecordingSection', () => {
  it('outside the desktop shell it explains that recording is unavailable and offers no switch', async () => {
    await mount();
    expect(document.querySelector('[data-testid="toggle-recording"]')).toBeNull();
    expect(document.querySelector('[data-testid="setting-recording-unavailable"]')?.textContent).toContain('desktop app');
  });

  it('reads the shell state, folder and cap, and saves a change that restarts the engine', async () => {
    const invoke = vi.fn<Invoke>(async (cmd) => (cmd === 'recording_settings'
      ? reply()
      : reply({ enabled: false, restarting: true })));
    installShell(invoke);
    await mount();
    expect(invoke).toHaveBeenCalledWith('recording_settings', undefined);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-testid="setting-recording-cap"]')?.textContent).toContain('20');
    expect(document.querySelector('[data-testid="setting-recording-folder"]')?.textContent).toContain('C:/data/recordings');

    await act(async () => toggle().click());
    expect(invoke).toHaveBeenLastCalledWith('set_recording_enabled', { enabled: false });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(state()).toContain('restarted');
  });

  it('says a change waits until the engine next starts when no engine was running', async () => {
    installShell(vi.fn<Invoke>(async (cmd) => (cmd === 'recording_settings'
      ? reply()
      : reply({ enabled: false, restarting: false }))));
    await mount();
    await act(async () => toggle().click());
    expect(state()).toContain('the next time the engine starts');
  });

  it('reports a refused change and keeps the last known state', async () => {
    installShell(vi.fn<Invoke>(async (cmd) => {
      if (cmd === 'recording_settings') return reply();
      throw new Error('disk full');
    }));
    await mount();
    await act(async () => toggle().click());
    expect(state()).toContain('Could not change recording');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(false);
  });

  it('says the settings could not be read and offers no switch to change them', async () => {
    installShell(vi.fn<Invoke>(async () => {
      throw new Error('engine down');
    }));
    await mount();
    expect(toggle().disabled).toBe(true);
    expect(state()).toContain('Could not read the recording settings');
  });

  it('shows a saving status while the change is in flight', async () => {
    let finish: (value: unknown) => void = () => undefined;
    installShell(vi.fn<Invoke>((cmd) => (cmd === 'recording_settings'
      ? Promise.resolve(reply())
      : new Promise((resolve) => { finish = resolve; }))));
    await mount();
    await act(async () => toggle().click());
    expect(state()).toContain('Saving');
    await act(async () => finish(reply({ enabled: false, restarting: true })));
    expect(state()).toContain('restarted');
  });
});
