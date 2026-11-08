import { useCallback, useEffect, useState } from 'react';

import {
  listenSidecarStatus,
  openLogFolder,
  readSidecarStatus,
  retrySidecar,
  type SidecarStatus,
} from '../net/sidecarStatus';

export interface EngineStatus {
  /** The desktop engine's phase, or null outside the desktop shell. */
  sidecar: SidecarStatus | null;
  /** Outcome of the last "Open log folder" press in the failed state. */
  logOpen: 'idle' | 'failed';
  onRetrySidecar: () => void;
  onOpenLogFolder: () => void;
}

/**
 * Desktop engine status. The shell publishes every phase change; the initial
 * read covers a window that opened after the event fired. Both are no-ops in a
 * plain browser, where `sidecar` stays null.
 */
export function useEngineStatus(): EngineStatus {
  const [sidecar, setSidecar] = useState<SidecarStatus | null>(null);
  const [logOpen, setLogOpen] = useState<'idle' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    const off = listenSidecarStatus((next) => {
      if (live) setSidecar(next);
    });
    void readSidecarStatus().then((next) => {
      if (live && next !== null) setSidecar((prev) => prev ?? next);
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  const onRetrySidecar = useCallback(() => {
    void retrySidecar();
  }, []);

  // "Open log folder" in the failed-engine state: the shell opens the app-data
  // folder that holds the engine log. Outside the shell there is none.
  const onOpenLogFolder = useCallback(() => {
    void openLogFolder().then((ok) => setLogOpen(ok ? 'idle' : 'failed'));
  }, []);

  return { sidecar, logOpen, onRetrySidecar, onOpenLogFolder };
}
