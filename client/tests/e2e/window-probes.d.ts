import type { LooseProbe } from './probe';

// Hooks the app and the specs share on `window`. Their shapes are open (see
// probe.ts), so each one is the loose probe type.
declare global {
  interface Window {
    __flowmapLive: LooseProbe;
    __flowmapTest: LooseProbe;
    __flowmapControls: LooseProbe;
    __overviewHistoryRequests: LooseProbe;
    __overviewWork: LooseProbe;
  }
}

export {};
