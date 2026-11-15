import { useT } from '../i18n/useT';

export function EurexSourceStatus({ capability }: { capability: Record<string, unknown> | null }) {
  const t = useT();
  if (capability?.source !== 'eurex_delayed_posttrade') return null;
  const stamp = (value: unknown) => {
    if ((typeof value !== 'string' && typeof value !== 'number') || !Number.isFinite(Number(value))) return '—';
    const date = new Date(Number(value) / 1e6);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '—';
  };
  const state = capability.status;
  const stateKey = capability.error_code === 'http_429' ? 'eurex.throttled' : ['error', 'backoff', 'storage_full'].includes(String(state)) ? 'eurex.error'
    : (state === 'syncing' || state === 'partial') && capability.collecting !== false ? 'eurex.syncing' : 'eurex.incomplete';
  return (
    <span className="cap cap--caution" data-testid="eurex-source-status" role="status"
      style={{ flexShrink: 1, minWidth: 220, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={`${t('eurex.source')} · ${t('eurex.incomplete')} · ${t(stateKey)} · ${t('eurex.unknown')} · ${t('eurex.detail', {
        event: stamp(capability.latest_event_ns), checked: stamp(capability.last_success_ns),
        pending: String(capability.pending_files ?? '—'),
      })} · ${t('eurex.terms')}`}>
      {t('eurex.source')} · {t('eurex.incomplete')}{stateKey !== 'eurex.incomplete' ? ` · ${t(stateKey)}` : ''} · {t('eurex.unknown')}
    </span>
  );
}
