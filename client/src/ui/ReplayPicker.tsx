import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sidecarFetch } from '../net/serverBase';
import { exchangeZoneFor, formatDateTime, formatNumber, resolveTimeZone, useTimeZone, zonedWallText, zonedWallToNs, zoneLabel } from '../i18n/format';
import { useT } from '../i18n/useT';
import { isTopOverlay, pushOverlay } from './overlayStack';
import { marketGroup } from './symbols';
import './ReplayPicker.css';

interface Availability {
  hours: string[];
  latest_column_ns: string | null;
  max_columns: number;
}
interface WindowPreview {
  start_ns: string;
  end_ns: string;
  columns: number;
}

export function utcDateTime(ns: bigint): string {
  return new Date(Number(ns / 1_000_000n)).toISOString().slice(0, 23);
}

export function utcDateTimeNs(value: string): bigint | null {
  const match = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  const ms = new Date(value + 'Z').getTime();
  if (!Number.isFinite(ms)) return null;
  const ns = BigInt(ms) * 1_000_000n;
  const normalized = value.length === 16 ? value + ':00.000' :
    value.length === 19 ? value + '.000' : value.padEnd(23, '0');
  return utcDateTime(ns) === normalized ? ns : null;
}

/**
 * One edge of the range. `ns` is the instant, kept exact when it came from the
 * API. `draft` is the text the user typed: shown as typed until the zone changes,
 * then the same instant is shown again in the new zone.
 */
interface RangeEdge { draft: string | null; ns: bigint | null }
const exactEdge = (ns: bigint): RangeEdge => ({ draft: null, ns });
const typedEdge = (draft: string, zone: string | undefined): RangeEdge => ({ draft, ns: zonedWallToNs(draft, zone) });
const msOf = (ns: bigint): number => Number(ns / 1_000_000n);
/** The text an edge shows in the picker's zone, in `datetime-local` form. */
const edgeText = (edge: RangeEdge, zone: string | undefined): string =>
  edge.draft ?? (edge.ns === null ? '' : zonedWallText(msOf(edge.ns), zone));
/** A readable instant in the picker's zone, with that zone's abbreviation. */
function zonedReadout(ns: bigint | null, zone: string | undefined): string {
  return ns === null ? '—' : formatDateTime(msOf(ns), {
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', timeZone: zone, timeZoneName: 'short',
  });
}

function utc(ns: bigint | null): string {
  return ns === null ? '—' : new Date(Number(ns / 1_000_000n)).toISOString();
}

/**
 * Why a recording request failed, as a category the picker can localize. The
 * server's own detail text is English internals and is never shown.
 */
export class ReplayRequestError extends Error {
  constructor(readonly kind: 'network' | 'http' | 'invalid', readonly status: number) {
    super(`replay request ${kind} ${status}`);
  }
}

/** The translation key that explains a failed recording request. */
function replayErrorKey(e: unknown): { key: string; status?: number } {
  if (!(e instanceof ReplayRequestError) || e.kind === 'network') return { key: 'replayPicker.errorUnreachable' };
  if (e.kind === 'invalid') return { key: 'replayPicker.errorResponse' };
  if (e.status === 404) return { key: 'replayPicker.errorRecordingOff' };
  if (e.status === 422) return { key: 'replayPicker.errorRejected' };
  return { key: 'replayPicker.errorHttp', status: e.status };
}

/**
 * Reads the body as text before anything else, so an HTML error page or an empty
 * body cannot throw a JSON SyntaxError before the status is checked, and a 422
 * detail array is never shown as "[object Object]".
 */
async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await sidecarFetch(path, { signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new ReplayRequestError('network', 0);
  }
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  // A non-JSON error body (an HTML 500 page, an empty body, a proxy page) means no
  // engine answered, so it reads as unreachable rather than as an HTTP detail.
  if (!response.ok) throw new ReplayRequestError(data === undefined ? 'network' : 'http', response.status);
  if (data === undefined || data === null || typeof data !== 'object') {
    throw new ReplayRequestError('invalid', response.status);
  }
  return data as T;
}

export function ReplayPicker({ market, symbol, onClose, onConfirm }: {
  market: string; symbol: string; onClose: () => void;
  onConfirm: (startNs: bigint, endNs: bigint) => void;
}): JSX.Element {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [start, setStart] = useState<RangeEdge>({ draft: '', ns: null });
  const [end, setEnd] = useState<RangeEdge>({ draft: '', ns: null });
  const [minutes, setMinutes] = useState(5);
  const [preview, setPreview] = useState<WindowPreview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<{ key: string; status?: number } | null>(null);
  // The server answered, but no recording store is attached (recording is off):
  // "no recordings" would then be a lie, so the picker says so instead.
  const [recordingOff, setRecordingOff] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const startNs = start.ns, endNs = end.ns;
  // The Settings zone decides every clock here: the hour list, the typed edges and
  // the readouts. The request itself always uses exact nanoseconds.
  const pref = useTimeZone();
  const exchange = exchangeZoneFor(marketGroup(market));
  const zone = resolveTimeZone(pref, exchange);
  const zoneText = zoneLabel(pref, exchange);
  // A typed edge is read again in the new zone; the instant it names is kept.
  useEffect(() => {
    setStart((edge) => (edge.ns === null ? edge : exactEdge(edge.ns)));
    setEnd((edge) => (edge.ns === null ? edge : exactEdge(edge.ns)));
  }, [zone]);
  const query = `market=${encodeURIComponent(market)}&symbol=${encodeURIComponent(symbol)}`;
  useEffect(() => pushOverlay('replay-picker'), []);
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented && isTopOverlay('replay-picker')) {
        e.preventDefault(); onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => { request.current?.abort(); opener?.focus(); };
  }, []);
  useEffect(() => {
    const ctrl = new AbortController();
    request.current?.abort();
    request.current = ctrl;
    setBusy(true); setError(null); setPreview(null); setRecordingOff(false);
    void readJson<Availability>(`/api/recordings/availability?${query}`, ctrl.signal).then(async (a) => {
      if (ctrl.signal.aborted) return;
      setAvailability(a);
      if (a.latest_column_ns !== null) {
        const latest = BigInt(a.latest_column_ns);
        setEnd(exactEdge(latest + 1_000_000_000n));
        setStart(exactEdge(latest - 300_000_000_000n));
      }
      if (a.hours.length === 0) {
        // An empty list means "nothing recorded" only while recording is on.
        const health = await readJson<{ recording_enabled?: boolean }>('/api/health', ctrl.signal).catch(() => null);
        if (!ctrl.signal.aborted && health?.recording_enabled === false) setRecordingOff(true);
      }
    }).catch((e: unknown) => {
      if (!ctrl.signal.aborted) setError(replayErrorKey(e));
    }).finally(() => { if (!ctrl.signal.aborted) setBusy(false); });
    return () => ctrl.abort();
  }, [query, refresh]);

  const changeRange = (nextStart: RangeEdge, nextEnd: RangeEdge): void => {
    request.current?.abort(); setBusy(false); setStart(nextStart); setEnd(nextEnd); setPreview(null); setError(null);
  };
  const preset = (duration: number, anchor = endNs): void => {
    setMinutes(duration);
    if (anchor !== null) changeRange(exactEdge(anchor - BigInt(duration) * 60_000_000_000n), exactEdge(anchor));
  };
  const checkWindow = async (): Promise<void> => {
    if (startNs === null || endNs === null || endNs <= startNs) { setError({ key: 'replayPicker.invalid' }); return; }
    const ctrl = new AbortController(); request.current?.abort(); request.current = ctrl;
    setBusy(true); setError(null);
    try {
      const p = await readJson<WindowPreview>(`/api/recordings/window?${query}&start_ns=${startNs}&end_ns=${endNs}`, ctrl.signal);
      if (!ctrl.signal.aborted) setPreview(p);
    } catch (e) { if (!ctrl.signal.aborted) setError(replayErrorKey(e)); }
    finally { if (!ctrl.signal.aborted) setBusy(false); }
  };
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!isTopOverlay('replay-picker')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    if (e.key !== 'Tab') return;
    const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
    if (!controls?.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return createPortal(<div className="replay-picker__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} className="replay-picker" role="dialog" aria-modal="true" aria-labelledby="replay-picker-title" onKeyDown={onKeyDown}>
      <header><h2 id="replay-picker-title">{t('replayPicker.title')} · {market} / {symbol}</h2>
        <button ref={close} type="button" onClick={onClose} aria-label={t('replayPicker.cancel')}>×</button></header>
      <p>{t('replayPicker.zone')} <strong>{zoneText}</strong> · {t('replayPicker.buckets')}</p>
      {busy && <p role="status">{t('replayPicker.loading')}</p>}
      {availability && availability.hours.length === 0 && <p role="status">{recordingOff ? t('replayPicker.recordingOff') : t('replayPicker.empty')}</p>}
      {availability && availability.hours.length > 0 && <>
        <label>{t('replayPicker.hours')}<select aria-label={t('replayPicker.hours')} value="" onChange={(e) => {
          if (!e.target.value) return;
          const hour = BigInt(e.target.value);
          changeRange(exactEdge(hour), exactEdge(hour + BigInt(minutes) * 60_000_000_000n));
        }}><option value="">{t('replayPicker.chooseHour')}</option>
          {availability.hours.map((h) => <option key={h} value={h}>{zonedWallText(msOf(BigInt(h)), zone).slice(0, 16).replace('T', ' ')} {zoneText}</option>)}
        </select></label>
        <div className="replay-picker__presets">{[1, 5, 15].map((m) => <button type="button" key={m} aria-pressed={minutes === m} onClick={() => preset(m)}>{t('replayPicker.minutes', { n: m })}</button>)}</div>
        <label>{t('replayPicker.start')} ({zoneText})<input type="datetime-local" step="0.001" value={edgeText(start, zone)} onChange={(e) => changeRange(typedEdge(e.target.value, zone), end)} /></label>
        <small>{zonedReadout(startNs, zone)}</small>
        <label>{t('replayPicker.end')} ({zoneText})<input type="datetime-local" step="0.001" value={edgeText(end, zone)} onChange={(e) => changeRange(start, typedEdge(e.target.value, zone))} /></label>
        <small>{zonedReadout(endNs, zone)} · {t('replayPicker.halfOpen')}</small>
        <p>{t('replayPicker.limit')} {formatNumber(availability.max_columns)} {t('replayPicker.columns')}</p>
      </>}
      {error && <p className="replay-picker__error" role="alert">{t(error.key, error.status === undefined ? undefined : { status: error.status })}</p>}
      {preview && <p role="status">{t('replayPicker.effective')} {utc(BigInt(preview.start_ns))} → {utc(BigInt(preview.end_ns))} · {preview.columns} {t('replayPicker.columns')}<br />{t('replayPicker.provenance')}</p>}
      <footer><button type="button" onClick={onClose}>{t('replayPicker.cancel')}</button>
        <button type="button" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>{t('replayPicker.refresh')}</button>
        {preview ? <button type="button" disabled={busy || startNs === null || endNs === null} onClick={() => {
          if (startNs !== null && endNs !== null) onConfirm(startNs, endNs);
        }}>{t('replayPicker.open')}</button> : <button type="button" disabled={busy || !availability?.hours.length} onClick={() => { void checkWindow(); }}>{t('replayPicker.check')}</button>}
      </footer>
    </div>
  </div>, document.body);
}
