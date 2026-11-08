/**
 * Non-depth stream messages for the overlays: book updates (only on a recorded
 * tier), trades, BBO, forming bars, markers and GEX. The feed keeps the last bar
 * it forwarded, so a byte-identical re-send of the forming bar changes nothing
 * and triggers no redraw (see barGate.ts). The depth columns take another path
 * (see depthIngest.ts).
 */

import { isRepeatBar } from '../barGate';
import type { StreamMsg } from '../../net/connection';
import { MsgType, type BarColumn } from '../../proto/types';
import type { StateSource, FrameState } from './frameState';
import type { FollowPolicy } from './followPolicy';
import type { OverlayLayer } from './overlayLayer';

/** What the overlay feed reads from its owner. */
export interface OverlayFeedHost {
  readonly store: StateSource;
  readonly overlayLayer: OverlayLayer;
  readonly follow: FollowPolicy;
  readonly frameState: FrameState;
}

export class OverlayFeed {
  /** The last bar column forwarded to the overlays; an identical repeat is dropped. */
  private lastBar: BarColumn | null = null;

  constructor(private readonly host: OverlayFeedHost) {}

  /** Forget the forwarded bar (a session reset: the next bar is always forwarded). */
  resetBar(): void {
    this.lastBar = null;
  }

  /**
   * Feed one non-depth message to the overlay manager. Returns true when the
   * overlays changed and the frame must be redrawn.
   */
  feed(msg: StreamMsg): boolean {
    const overlays = this.host.overlayLayer.overlays;
    switch (msg.type) {
      case MsgType.BOOK_UPDATE:
        if (this.host.store.getState().capability?.depth_provenance !== 'recorded-density') return false;
        overlays.onRecordedBook(msg);
        break;
      case MsgType.TRADE:
        overlays.onTrade(msg);
        break;
      case MsgType.BBO:
        overlays.onBbo(msg, this.host.store.getState().capability?.depth_provenance === 'recorded-density');
        break;
      case MsgType.BAR_COL:
        // The forming bar is re-sent on every flush tick. An identical repeat
        // changes no overlay state, so it is dropped before any redraw.
        if (isRepeatBar(this.lastBar, msg)) return false;
        this.lastBar = msg;
        overlays.onBar(msg);
        // Snapshot pairs are depth→bar. Coalesce their price input changes
        // for the next presentation, including a paused final/only column.
        if (Number.isFinite(msg.c) && msg.c > 0) this.host.follow.barPriceFitPending = true;
        break;
      case MsgType.MARKER:
        overlays.onMarker(msg);
        break;
      case MsgType.GEX_UPDATE:
        overlays.onGex(msg);
        break;
      default:
        return false;
    }
    return true;
  }
}
