import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SidecarStatus } from '../net/sidecarStatus';
import { useEngineStatus, type EngineStatus } from './useEngineStatus';

const sidecar = vi.hoisted(() => ({
  listen: vi.fn((): (() => void) => () => {}),
  read: vi.fn(async (): Promise<SidecarStatus | null> => null),
  retry: vi.fn(async (): Promise<boolean> => true),
  openLog: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('../net/sidecarStatus', () => ({
  listenSidecarStatus: sidecar.listen,
  readSidecarStatus: sidecar.read,
  retrySidecar: sidecar.retry,
  openLogFolder: sidecar.openLog,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: EngineStatus | null = null;

function Probe(): null {
  latest = useEngineStatus();
  return null;
}

let container: HTMLElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Probe />));
}

beforeEach(() => {
  latest = null;
  sidecar.listen.mockClear();
  sidecar.read.mockReset().mockResolvedValue(null);
  sidecar.retry.mockClear();
  sidecar.openLog.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useEngineStatus', () => {
  it('takes the engine state from the initial read when no event arrived first', async () => {
    const failed: SidecarStatus = { state: 'failed', port: 8731, logPath: 'C:/logs/engine.log', detail: 'gave up' } as SidecarStatus;
    sidecar.read.mockResolvedValue(failed);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.sidecar).toEqual(failed);
  });

  it('reports a failed log-folder open so it is said, not silent', async () => {
    sidecar.openLog.mockResolvedValue(false);
    mount();
    await act(async () => {
      latest?.onOpenLogFolder();
      await Promise.resolve();
    });
    expect(latest?.logOpen).toBe('failed');
  });

  it('asks the shell to retry the engine', () => {
    mount();
    act(() => latest?.onRetrySidecar());
    expect(sidecar.retry).toHaveBeenCalledOnce();
  });

  it('detaches its status listener on unmount', () => {
    const off = vi.fn();
    sidecar.listen.mockReturnValue(off);
    mount();
    act(() => root.unmount());
    expect(off).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
