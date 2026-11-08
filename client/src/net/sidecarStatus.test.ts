import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inDesktopShell,
  listenSidecarStatus,
  openLogFolder,
  parseSidecarStatus,
  readSidecarStatus,
  retrySidecar,
  whenSidecarReady,
} from './sidecarStatus';

type Win = { __TAURI_INTERNALS__?: unknown };

function installShell(invoke: ReturnType<typeof vi.fn>): { callbacks: Map<number, (p: unknown) => void> } {
  const callbacks = new Map<number, (p: unknown) => void>();
  let next = 1;
  (window as unknown as Win).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: (cb: (p: unknown) => void) => {
      const id = next++;
      callbacks.set(id, cb);
      return id;
    },
  };
  return { callbacks };
}

beforeEach(() => {
  delete (window as unknown as Win).__TAURI_INTERNALS__;
});

afterEach(() => {
  delete (window as unknown as Win).__TAURI_INTERNALS__;
});

describe('parseSidecarStatus', () => {
  it('accepts the five phases and keeps the log path for the failed state', () => {
    expect(parseSidecarStatus({ state: 'failed', port: 8731, logPath: 'C:/logs/flowmap-server.log', detail: 'gave up' }))
      .toEqual({ state: 'failed', port: 8731, logPath: 'C:/logs/flowmap-server.log', detail: 'gave up' });
    expect(parseSidecarStatus({ state: 'external' })).toEqual({ state: 'external', port: null, logPath: null, detail: '' });
  });

  it('rejects unknown phases and non-objects', () => {
    expect(parseSidecarStatus({ state: 'exploded' })).toBeNull();
    expect(parseSidecarStatus({ port: 1 })).toBeNull();
    expect(parseSidecarStatus('live')).toBeNull();
    expect(parseSidecarStatus(null)).toBeNull();
  });
});

describe('sidecar bridge outside the desktop shell', () => {
  it('reports no shell and every helper is a silent no-op', async () => {
    expect(inDesktopShell()).toBe(false);
    expect(await readSidecarStatus()).toBeNull();
    expect(await retrySidecar()).toBe(false);
    const off = listenSidecarStatus(() => {
      throw new Error('never called');
    });
    expect(() => off()).not.toThrow();
  });
});

describe('sidecar bridge inside the desktop shell', () => {
  it('reads the latest status through the sidecar_status command', async () => {
    const invoke = vi.fn(async () => ({ state: 'live', port: 9000, logPath: null, detail: '' }));
    installShell(invoke);
    expect(inDesktopShell()).toBe(true);
    expect(await readSidecarStatus()).toEqual({ state: 'live', port: 9000, logPath: null, detail: '' });
    expect(invoke).toHaveBeenCalledWith('sidecar_status');
  });

  it('treats a rejected command as no status rather than throwing', async () => {
    installShell(vi.fn(async () => {
      throw new Error('denied');
    }));
    expect(await readSidecarStatus()).toBeNull();
  });

  it('retry_sidecar reports success and failure', async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'retry_sidecar') return undefined;
      return null;
    });
    installShell(invoke);
    expect(await retrySidecar()).toBe(true);
    expect(invoke).toHaveBeenCalledWith('retry_sidecar');
    invoke.mockImplementationOnce(async () => {
      throw new Error('no supervisor');
    });
    expect(await retrySidecar()).toBe(false);
  });

  it('open_log_folder reports whether the shell started the file manager', async () => {
    const invoke = vi.fn(async () => undefined);
    installShell(invoke);
    expect(await openLogFolder()).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_log_folder');
    invoke.mockImplementationOnce(async () => {
      throw new Error('no opener');
    });
    expect(await openLogFolder()).toBe(false);
  });

  it('listens on sidecar-status, forwards valid payloads only, and unlistens on dispose', async () => {
    const invoke = vi.fn(async (cmd: string) => (cmd === 'plugin:event|listen' ? 42 : undefined));
    const { callbacks } = installShell(invoke);
    const seen: string[] = [];
    const off = listenSidecarStatus((s) => seen.push(s.state));
    await Promise.resolve();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('plugin:event|listen', expect.objectContaining({ event: 'sidecar-status' }));
    const listenArgs = invoke.mock.calls[0] as unknown as [string, { handler: number }];
    const handler = listenArgs[1].handler;
    callbacks.get(handler)?.({ event: 'sidecar-status', payload: { state: 'restarting' } });
    callbacks.get(handler)?.({ event: 'sidecar-status', payload: { state: 'bogus' } });
    expect(seen).toEqual(['restarting']);
    off();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('plugin:event|unlisten', { event: 'sidecar-status', eventId: 42 });
  });
});

describe('whenSidecarReady', () => {
  /** Let the pending IPC promises settle. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  function shellReporting(state: string): { callbacks: Map<number, (p: unknown) => void>; invoke: ReturnType<typeof vi.fn> } {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'sidecar_status') return { state, port: null, logPath: null, detail: '' };
      if (cmd === 'plugin:event|listen') return 7;
      return undefined;
    });
    const { callbacks } = installShell(invoke);
    return { callbacks, invoke };
  }

  function emitStatus(callbacks: Map<number, (p: unknown) => void>, invoke: ReturnType<typeof vi.fn>, state: string): void {
    const listenArgs = invoke.mock.calls.find((c) => c[0] === 'plugin:event|listen')![1] as unknown as { handler: number };
    callbacks.get(listenArgs.handler)?.({ event: 'sidecar-status', payload: { state } });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts at once outside the desktop shell', () => {
    const start = vi.fn();
    whenSidecarReady(start);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('waits for the engine to report live, then starts exactly once', async () => {
    const { callbacks, invoke } = shellReporting('starting');
    const start = vi.fn();
    whenSidecarReady(start);
    await flush();
    expect(start).not.toHaveBeenCalled();
    emitStatus(callbacks, invoke, 'restarting');
    expect(start).not.toHaveBeenCalled();
    emitStatus(callbacks, invoke, 'live');
    expect(start).toHaveBeenCalledTimes(1);
    emitStatus(callbacks, invoke, 'live');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts at once when the engine already answers before the listener attaches', async () => {
    shellReporting('live');
    const start = vi.fn();
    whenSidecarReady(start);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts after the wait even when the engine never reports ready (a failed engine gets its notice and attempts)', async () => {
    vi.useFakeTimers();
    shellReporting('failed');
    const start = vi.fn();
    whenSidecarReady(start, 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('cancelling before the engine is ready means the connect never starts', async () => {
    const { callbacks, invoke } = shellReporting('starting');
    const start = vi.fn();
    const cancel = whenSidecarReady(start);
    await flush();
    cancel();
    emitStatus(callbacks, invoke, 'live');
    expect(start).not.toHaveBeenCalled();
  });
});
