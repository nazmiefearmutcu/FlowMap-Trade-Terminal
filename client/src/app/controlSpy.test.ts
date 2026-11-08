import { afterEach, describe, expect, it, vi } from 'vitest';

import { installControlSpy } from './controlSpy';
import { setFlowMapTransport, useFlowMapStore } from '../state/store';

/** Records the arguments each socket was constructed with; never opens a network connection. */
class RecordingSocket {
  static created: { url: string; protocols: string[] | undefined }[] = [];
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string, protocols?: string | string[]) {
    RecordingSocket.created.push({
      url,
      protocols: protocols === undefined ? undefined : [protocols].flat(),
    });
  }
  send(): void {}
  close(): void {}
}

afterEach(() => {
  useFlowMapStore.getState().disconnect();
  setFlowMapTransport({});
  vi.unstubAllGlobals();
  RecordingSocket.created = [];
  delete (window as { __flowmapControls?: unknown }).__flowmapControls;
  delete (window as { __FLOWMAP_SESSION_TOKEN__?: string }).__FLOWMAP_SESSION_TOKEN__;
});

describe('installControlSpy', () => {
  it('forwards the subprotocol list to the WebSocket, so a token-checking sidecar accepts the spy socket', () => {
    vi.stubGlobal('WebSocket', RecordingSocket);
    (window as { __FLOWMAP_SESSION_TOKEN__?: string }).__FLOWMAP_SESSION_TOKEN__ = 'ab'.repeat(32);
    installControlSpy();

    useFlowMapStore.getState().connectAndSubscribe('crypto', 'BTCUSDT');

    expect(RecordingSocket.created).toHaveLength(1);
    expect(RecordingSocket.created[0].protocols).toEqual(['flowmap.v1', `flowmap.auth.${'ab'.repeat(32)}`]);
    expect(RecordingSocket.created[0].url).not.toContain('ab'.repeat(32));
  });
});
