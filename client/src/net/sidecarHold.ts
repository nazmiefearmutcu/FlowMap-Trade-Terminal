/**
 * Hold a connection's socket opens while the desktop shell is bringing its
 * engine back.
 *
 * A restart reuses the same port and the same session token. A socket opened in
 * that window would hand the token to whatever process answers the port
 * meanwhile, so the connection parks its opens while the shell reports
 * `starting` or `restarting` (see `Connection.setSidecarHold`). REST calls are
 * parked by the same window (see `setSidecarRestHold`). A `failed` engine is not
 * held: its connect attempts and their notice are kept on purpose (see
 * `whenSidecarReady`).
 */

import { listenSidecarStatus, readSidecarStatus, type SidecarStatus } from './sidecarStatus';
import { setSidecarRestHold } from './serverBase';

/** The part of a Connection that the hold drives. */
export interface SidecarHoldTarget {
  setSidecarHold(held: boolean): void;
}

/** Shell states in which the engine is expected back on the same port and token. */
function engineComingBack(status: SidecarStatus): boolean {
  return status.state === 'starting' || status.state === 'restarting';
}

/**
 * Follow the shell's sidecar status for `target` until the returned cancel runs.
 * Outside the desktop shell no status ever arrives, so nothing is held. An
 * unknown status (no event yet) holds nothing either. Cancelling while held
 * releases the REST hold, since nothing else would.
 */
export function holdWhileSidecarDown(target: SidecarHoldTarget): () => void {
  let active = true;
  let held = false;
  const apply = (status: SidecarStatus | null): void => {
    if (!active || status === null) return;
    held = engineComingBack(status);
    target.setSidecarHold(held);
    setSidecarRestHold(held);
  };
  const unlisten = listenSidecarStatus(apply);
  void readSidecarStatus().then(apply);
  return () => {
    active = false;
    unlisten();
    if (held) {
      held = false;
      setSidecarRestHold(false);
    }
  };
}
