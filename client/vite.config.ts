import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only: point the page's REST + WebSocket traffic STRAIGHT at the server
 * (`FLOWMAP_DEV_SERVER_PORT`, else the server's own `FLOWMAP_PORT`, else 8720)
 * instead of relaying through vite's proxy.
 *
 * Why the proxy is bypassed for the stream: a HistoryResponse is one large
 * binary WS frame (up to several MB), and the vite/http-proxy ws relay
 * measurably chokes on exactly those — the server-side socket errors with
 * ECONNABORTED, the client's history request times out, and every live frame
 * queued behind the stuck one freezes with it (head-of-line blocking on ONE
 * shared socket; measured 2026-09-20 on live BTCUSDT). The client already
 * supports an injected absolute server origin (the Tauri shell sets the same
 * global), and the server's REST-CORS + WS origin gates allow the vite origins
 * cross-origin, so a direct connection in dev makes dev behave like the
 * packaged app. The proxy entries stay in place as a same-origin fallback.
 */
function directServerOrigin(serverOrigin: string): Plugin {
  return {
    name: 'flowmap-direct-server-origin',
    transformIndexHtml(html, ctx) {
      // Dev server only — a production build must not bake in a loopback port.
      if (!ctx.server) return html;
      return html.replace(
        '<head>',
        `<head>
    <script>window.__FLOWMAP_SERVER__ = ${JSON.stringify(serverOrigin)};</script>`,
      );
    },
  };
}

/**
 * Read an optional TCP port from the environment, so a second dev stack (for
 * example an e2e run beside a developer's own) can use other ports. Unset or
 * blank means the default; anything else that is not a port number fails the
 * config load rather than binding the wrong port.
 */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port (1-65535), got "${raw}"`);
  }
  return port;
}

/**
 * flowmap-server port the dev client talks to: the dev override, else the port the
 * server itself listens on (`FLOWMAP_PORT`), else the shared default 8720.
 */
const SERVER_PORT = portFromEnv('FLOWMAP_DEV_SERVER_PORT', portFromEnv('FLOWMAP_PORT', 8720));
/** Vite dev-server port for the client. */
const CLIENT_PORT = portFromEnv('FLOWMAP_DEV_CLIENT_PORT', 5173);
const SERVER_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

// FlowMap client dev server. The page talks to the flowmap-server DIRECTLY (see
// directServerOrigin above); the /api + /ws proxy entries remain as a
// same-origin fallback for tools that bypass the injected global. The server's
// origin gate accepts any loopback dev port unless FLOWMAP_WS_ALLOWED_ORIGINS
// replaces that list, so CLIENT_PORT may move freely.
export default defineConfig({
  plugins: [react(), directServerOrigin(SERVER_ORIGIN)],
  server: {
    port: CLIENT_PORT,
    strictPort: true,
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://127.0.0.1:${SERVER_PORT}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
