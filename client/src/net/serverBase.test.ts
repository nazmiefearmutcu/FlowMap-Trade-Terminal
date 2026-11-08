import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiBase,
  serverOrigin,
  SIDECAR_REST_HOLD_MS,
  setSidecarRestHold,
  sessionToken,
  sidecarFetch,
  withSessionHeader,
  wsProtocols,
  wsUrl,
} from './serverBase';

/**
 * The server-URL base that lets one client build run both same-origin in the
 * vite dev server and against an absolute loopback URL inside the packaged
 * Tauri app (which injects `window.__FLOWMAP_SERVER__`).
 */
describe('serverBase', () => {
  afterEach(() => {
    delete (window as { __FLOWMAP_SERVER__?: string }).__FLOWMAP_SERVER__;
    delete (window as { __FLOWMAP_SESSION_TOKEN__?: string }).__FLOWMAP_SESSION_TOKEN__;
    setSidecarRestHold(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('is same-origin when the global is absent (dev / vite proxy)', () => {
    expect(serverOrigin()).toBeNull();
    expect(apiBase()).toBe(''); // relative → proxied
  });

  it('derives the WS URL from window.location when same-origin', () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    // nosemgrep: loopback dev WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://localhost:5173/ws');
  });

  it('uses wss when the page is served over https', () => {
    vi.stubGlobal('location', { protocol: 'https:', host: 'example.test' });
    expect(wsUrl()).toBe('wss://example.test/ws');
  });

  it('reads the injected origin as the REST base in the packaged app', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    expect(serverOrigin()).toBe('http://127.0.0.1:52791');
    expect(apiBase()).toBe('http://127.0.0.1:52791');
  });

  it('builds an absolute loopback WebSocket URL from an injected http origin', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    // nosemgrep: loopback sidecar WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://127.0.0.1:52791/ws');
  });

  it('builds a secure WebSocket URL from an injected https origin', () => {
    window.__FLOWMAP_SERVER__ = 'https://127.0.0.1:52791';
    expect(wsUrl()).toBe('wss://127.0.0.1:52791/ws');
  });

  it('tolerates a trailing slash in the injected origin', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791/';
    expect(apiBase()).toBe('http://127.0.0.1:52791');
    // nosemgrep: loopback sidecar WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://127.0.0.1:52791/ws');
  });

  it('reads no session token in dev mode (absent global)', () => {
    expect(sessionToken()).toBeNull();
    expect(withSessionHeader({ method: 'GET' })).toEqual({ method: 'GET' });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
    // nosemgrep: loopback dev WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://localhost:5173/ws');
  });

  it('treats an empty injected token as absent', () => {
    window.__FLOWMAP_SESSION_TOKEN__ = '';
    expect(sessionToken()).toBeNull();
  });

  it('adds the X-FlowMap-Token header to REST calls when a token is injected', async () => {
    const hex = 'ab'.repeat(32);
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    window.__FLOWMAP_SESSION_TOKEN__ = hex;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    await sidecarFetch('/api/symbols');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:52791/api/symbols');
    expect(new Headers(init.headers).get('X-FlowMap-Token')).toBe(hex);
  });

  it('keeps caller headers when adding the session header', () => {
    window.__FLOWMAP_SESSION_TOKEN__ = 'cafe';
    const init = withSessionHeader({ headers: { Accept: 'application/json' } });
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-FlowMap-Token')).toBe('cafe');
  });

  it('keeps the token out of the WebSocket URL and offers it as a subprotocol', () => {
    window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
    window.__FLOWMAP_SESSION_TOKEN__ = 'abc123';
    // nosemgrep: loopback sidecar WebSocket URL — assertion, not a live connection.
    expect(wsUrl()).toBe('ws://127.0.0.1:52791/ws');
    expect(wsProtocols()).toEqual(['flowmap.v1', 'flowmap.auth.abc123']);
  });

  it('offers only the wire version when no token is injected', () => {
    expect(wsProtocols()).toEqual(['flowmap.v1']);
  });

  describe('REST hold while the engine restarts', () => {
    const hex = 'cd'.repeat(32);

    function stubFetch(): ReturnType<typeof vi.fn> {
      window.__FLOWMAP_SERVER__ = 'http://127.0.0.1:52791';
      window.__FLOWMAP_SESSION_TOKEN__ = hex;
      const fetchMock = vi.fn(async () => new Response('{}'));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('parks a REST call until the hold is released, then sends it with the token', async () => {
      const fetchMock = stubFetch();
      setSidecarRestHold(true);
      const pending = sidecarFetch('/api/symbols');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();

      setSidecarRestHold(false);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(new Headers(init.headers).get('X-FlowMap-Token')).toBe(hex);
    });

    it('releases every parked call together', async () => {
      const fetchMock = stubFetch();
      setSidecarRestHold(true);
      const a = sidecarFetch('/api/a');
      const b = sidecarFetch('/api/b');
      setSidecarRestHold(false);
      await Promise.all([a, b]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails a parked call after the bound, and never sends it the token', async () => {
      vi.useFakeTimers();
      const fetchMock = stubFetch();
      setSidecarRestHold(true);
      const pending = sidecarFetch('/api/symbols').then(
        () => 'sent',
        (err: unknown) => (err instanceof Error ? err.message : 'other'),
      );
      await vi.advanceTimersByTimeAsync(SIDECAR_REST_HOLD_MS);
      expect(await pending).toBe('flowmap: sidecar did not come back');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a parked call whose signal aborts, without waiting for the release', async () => {
      const fetchMock = stubFetch();
      const controller = new AbortController();
      setSidecarRestHold(true);
      const pending = sidecarFetch('/api/symbols', { signal: controller.signal });
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects at once when the signal is already aborted', async () => {
      const fetchMock = stubFetch();
      const controller = new AbortController();
      controller.abort();
      setSidecarRestHold(true);
      await expect(sidecarFetch('/api/symbols', { signal: controller.signal })).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('sends at once when no hold is set', async () => {
      const fetchMock = stubFetch();
      await sidecarFetch('/api/symbols');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
