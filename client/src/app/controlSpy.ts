import { decodeFrame } from '../proto/decode';
import type { SocketLike } from '../net/connection';
import { setFlowMapTransport } from '../state/store';

/**
 * Dev/e2e control tap (`?spy=1`): wrap the WebSocket so every outbound control
 * frame is decoded (bigints → strings) into `window.__flowmapControls`, letting a
 * spec assert the exact Subscribe / Pause / Resume / SetSpeed / Seek messages the
 * transport sends. Never installed in production (the query param gates it).
 */
export function installControlSpy(): void {
  const sent: unknown[] = [];
  (window as unknown as { __flowmapControls: unknown[] }).__flowmapControls = sent;
  const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);
  setFlowMapTransport({
    // The subprotocol list (wire version and session token) must reach the
    // socket: a sidecar that checks the token refuses a spy socket that offers none.
    wsFactory: (url: string, protocols: string[]): SocketLike => {
      const ws = new WebSocket(url, protocols);
      const origSend = ws.send.bind(ws);
      ws.send = ((data: ArrayBufferLike | ArrayBufferView | string): void => {
        try {
          let u8: Uint8Array | null = null;
          if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
          else if (ArrayBuffer.isView(data)) {
            u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          }
          if (u8 && u8.length) {
            for (const m of decodeFrame(u8)) sent.push(JSON.parse(JSON.stringify(m, replacer)));
          }
        } catch {
          /* never let the tap break the socket */
        }
        origSend(data as never);
      }) as typeof ws.send;
      return ws as unknown as SocketLike;
    },
  });
}
