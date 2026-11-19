import { exchangeZoneFor, formatDateTime, resolveTimeZone, useTimeZone } from '../i18n/format';
import { useT } from '../i18n/useT';

function formatStamp(value: unknown, timeZone: string | undefined): string {
  let ms: number;
  if (typeof value === 'bigint') {
    ms = Number(value / 1_000_000n);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    ms = value / 1e6;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return '—';
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return '—';
    ms = n / 1e6;
  } else {
    return '—';
  }
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return '—';
  return formatDateTime(ms, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone, timeZoneName: 'short',
  });
}

export function EurexSourceStatus({ capability }: { capability: Record<string, unknown> | null }) {
  const t = useT();
  const pref = useTimeZone();
  if (capability?.source !== 'eurex_delayed_posttrade') return null;
  const zone = resolveTimeZone(pref, exchangeZoneFor('futures', 'eurex'));
  const state = capability.status;
  const stateKey = capability.error_code === 'http_429' ? 'eurex.throttled' : ['error', 'backoff', 'storage_full'].includes(String(state)) ? 'eurex.error'
    : (state === 'syncing' || state === 'partial') && capability.collecting !== false ? 'eurex.syncing' : 'eurex.incomplete';
  const statusPart = stateKey !== 'eurex.incomplete' ? ` · ${t(stateKey)}` : '';
  return (
    <span className="cap cap--caution topbar__eurex" data-testid="eurex-source-status" role="status"
      title={`${t('eurex.source')} · ${t('eurex.incomplete')}${statusPart} · ${t('eurex.unknown')} · ${t('eurex.detail', {
        event: formatStamp(capability.latest_event_ns, zone), checked: formatStamp(capability.last_success_ns, zone),
        pending: String(capability.pending_files ?? '—'),
      })} · ${t('eurex.terms')}`}>
      {t('eurex.source')} · {t('eurex.incomplete')}{statusPart} · {t('eurex.unknown')}
    </span>
  );
}
