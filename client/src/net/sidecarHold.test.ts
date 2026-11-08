import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setSidecarRestHold, sidecarFetch } from './serverBase';
import { holdWhileSidecarDown, type SidecarHoldTarget } from './sidecarHold';

type Win = { __TAURI_INTERNALS__?: unknown };

/** Installs a fake shell bridge; `emit` plays a sidecar-status event through the listener. */
function installShell(initial: unknown): { emit: (payload: unknown) => void } {
  const callbacks = new Map<number, (p: unknown) => void>();
  let next = 1;
  const invoke = vi.fn(async (cmd: string) => {
    if (cmd === 'sidecar_status') return initial;
    if (cmd === 'plugin:event|listen') return 7;
    return undefined;
  });
  (window as unknown as Win).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (p: unknown) => void) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
  };
  return {
    emit: (payload) => {
      for (const cb of callbacks.values()) cb({ payload });
    },
  };
}

function recordingTarget(): SidecarHoldTarget & { calls: boolean[] } {
  const calls: boolean[] = [];
  return { calls, setSidecarHold: (held: boolean) => calls.push(held) };
}

/** Lets the pending `sidecar_status` read settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  delete (window as unknown as Win).__TAURI_INTERNALS__;
});

afterEach(() => {
  delete (window as unknown as Win).__TAURI_INTERNALS__;
  setSidecarRestHold(false);
  vi.unstubAllGlobals();
});

describe('holdWhileSidecarDown', () => {
  it('holds nothing outside the desktop shell', async () => {
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    expect(target.calls).toEqual([]);
    stop();
  });

  it('holds while the shell reports the engine down and releases when it answers', async () => {
    const shell = installShell({ state: 'restarting' });
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    expect(target.calls).toEqual([true]);

    shell.emit({ state: 'starting' });
    shell.emit({ state: 'live' });
    expect(target.calls).toEqual([true, true, false]);
    stop();
  });

  it('treats an external engine as answering', async () => {
    const shell = installShell({ state: 'restarting' });
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    shell.emit({ state: 'external' });
    expect(target.calls).toEqual([true, false]);
    stop();
  });

  it('does not hold a failed engine, so its connect attempts and notice keep running', async () => {
    const shell = installShell({ state: 'failed' });
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    expect(target.calls).toEqual([false]);

    shell.emit({ state: 'restarting' });
    shell.emit({ state: 'failed' });
    expect(target.calls).toEqual([false, true, false]);
    stop();
  });

  it('ignores malformed payloads and an unknown initial status', async () => {
    const shell = installShell(null);
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    shell.emit({ state: 'exploded' });
    expect(target.calls).toEqual([]);
    stop();
  });

  it('stops following the shell once cancelled', async () => {
    const shell = installShell({ state: 'live' });
    const target = recordingTarget();
    const stop = holdWhileSidecarDown(target);
    await settle();
    stop();
    shell.emit({ state: 'restarting' });
    expect(target.calls).toEqual([false]);
  });

  it('parks REST calls for the same window and sends them once the engine answers', async () => {
    const shell = installShell({ state: 'restarting' });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const stop = holdWhileSidecarDown(recordingTarget());
    await settle();

    const pending = sidecarFetch('/api/symbols');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    shell.emit({ state: 'live' });
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('releases parked REST calls when cancelled while the engine is held', async () => {
    installShell({ state: 'restarting' });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const stop = holdWhileSidecarDown(recordingTarget());
    await settle();

    const pending = sidecarFetch('/api/symbols');
    stop();
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
