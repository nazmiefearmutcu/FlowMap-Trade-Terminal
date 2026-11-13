import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMacro, MACRO_LOAD_FAILED_MESSAGE, parseMacroReading } from './macroApi';
import { sidecarFetch } from './serverBase';

vi.mock('./serverBase', () => ({ sidecarFetch: vi.fn() }));

const wire = {
  sofr: 3.9,
  sofrDate: '2026-11-12',
  yield10y2y: 0.24,
  curveDate: '2026-11-12',
  hySpread: null,
  hyDate: null,
  stressScore: null,
  status: null,
  sourceStatus: { SOFR: 'ok', BAMLH0A0HYM2: 'fred_api_key_missing', T10Y2Y: 'ok' },
  sources: { SOFR: 'New York Fed', T10Y2Y: 'US Treasury', BAMLH0A0HYM2: 'FRED' },
  asOf: 1_700_000_000_000,
  stale: false,
};

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.mocked(sidecarFetch).mockReset();
});

describe('parseMacroReading', () => {
  it('keeps finite numbers and non-empty strings', () => {
    expect(parseMacroReading(wire)).toMatchObject({
      sofr: 3.9, sofrDate: '2026-11-12', yield10y2y: 0.24, hySpread: null,
      sourceStatus: wire.sourceStatus, sources: wire.sources, asOf: 1_700_000_000_000, stale: false,
    });
  });

  it('turns a figure that is not a finite number into null, never a guess', () => {
    const reading = parseMacroReading({ ...wire, sofr: '3.9', hySpread: Number.NaN, yield10y2y: Infinity, stressScore: true });
    expect(reading).toMatchObject({ sofr: null, hySpread: null, yield10y2y: null, stressScore: null });
  });

  it('turns an empty or non-string date or status into null', () => {
    const reading = parseMacroReading({ ...wire, sofrDate: '', curveDate: 20261112, status: '' });
    expect(reading).toMatchObject({ sofrDate: null, curveDate: null, status: null });
  });

  it('drops source entries that are not strings', () => {
    const reading = parseMacroReading({ ...wire, sourceStatus: { SOFR: 'ok', T10Y2Y: 7 }, sources: 'FRED' });
    expect(reading?.sourceStatus).toEqual({ SOFR: 'ok' });
    expect(reading?.sources).toEqual({});
  });

  it('reads stale only when the server sends true', () => {
    expect(parseMacroReading({ ...wire, stale: 'true' })?.stale).toBe(false);
    expect(parseMacroReading({ ...wire, stale: true })?.stale).toBe(true);
  });

  it('returns null for a body that is not an object', () => {
    expect(parseMacroReading(null)).toBeNull();
    expect(parseMacroReading('macro')).toBeNull();
    expect(parseMacroReading([])).not.toBeNull();
  });
});

describe('fetchMacro', () => {
  it('returns the validated reading from GET /api/macro', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, wire));
    const reading = await fetchMacro();
    expect(sidecarFetch).toHaveBeenCalledWith('/api/macro', { signal: undefined });
    expect(reading.sofr).toBe(3.9);
  });

  it('passes the abort signal through to the request', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, wire));
    const controller = new AbortController();
    await fetchMacro(controller.signal);
    expect(sidecarFetch).toHaveBeenCalledWith('/api/macro', { signal: controller.signal });
  });

  it('rejects with the server reason on a 503', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(
      reply(503, { error: { code: 'macro_unavailable', message: 'Macro data is unavailable right now (SOFR unreachable)' } }),
    );
    await expect(fetchMacro()).rejects.toThrow('Macro data is unavailable right now (SOFR unreachable)');
  });

  it('rejects with the status when an error body has no reason', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(500, 'not json'));
    await expect(fetchMacro()).rejects.toThrow(`${MACRO_LOAD_FAILED_MESSAGE} (HTTP 500)`);
  });

  it('rejects when a success body is not JSON', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, '<html>not json</html>'));
    await expect(fetchMacro()).rejects.toThrow(MACRO_LOAD_FAILED_MESSAGE);
  });

  it('rejects when a success body is not an object', async () => {
    vi.mocked(sidecarFetch).mockResolvedValue(reply(200, 42));
    await expect(fetchMacro()).rejects.toThrow(MACRO_LOAD_FAILED_MESSAGE);
  });
});
