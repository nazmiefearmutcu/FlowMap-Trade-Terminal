/**
 * The top bar's clock: the wall time in the one zone preference (Settings → Time
 * zone), the US-eastern reference beside it for equity sessions, and the stream's
 * latest timestamp. The wall clock owns its 1 Hz tick here, so the rest of the bar
 * does not re-render every second.
 */

import { useEffect, useState } from 'react';

import { exchangeZoneFor, formatClock, useTimeZone, zoneLabel } from '../i18n/format';
import { useT } from '../i18n/useT';
import type { SymbolGroupKey } from './symbols';

interface TopBarClockProps {
  group: SymbolGroupKey;
  /** Formatted latest-stream timestamp (or null before the first tick). */
  streamClock: string | null;
}

export function TopBarClock({ group, streamClock }: TopBarClockProps) {
  const t = useT();
  const zonePref = useTimeZone();
  const [wall, setWall] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setWall(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const exchangeZone = exchangeZoneFor(group);
  const wallMs = wall.getTime();
  const wallText = formatClock(wallMs, zonePref, exchangeZone);
  const zoneAbbrev = zoneLabel(zonePref, exchangeZone, wallMs);
  // For equity sessions the reference clock is US-eastern; show it beside the stream ts
  // unless the preference already reads exchange time.
  const etText =
    group === 'equity' && zonePref !== 'exchange' ? formatClock(wallMs, 'exchange', 'America/New_York') : null;

  return (
    <span
      className="clock"
      data-testid="clock"
      role="group"
      aria-label={`${t('topbar.wallClockAria', { time: wallText, zone: zoneAbbrev })}${
        etText ? t('topbar.easternAria', { time: etText }) : ''
      }${t('topbar.streamAria', { stream: streamClock ?? t('topbar.streamNone') })}${
        streamClock ? (group === 'sim' ? t('topbar.sessionRelative') : t('topbar.utcSuffix')) : ''
      }`}
    >
      <span className="clock__wall">
        {wallText} <span className="clock__zone">{zoneAbbrev}</span>
      </span>
      {etText ? <span className="clock__et">{etText} {t('topbar.easternShort')}</span> : null}
      {/* The sim's stream ts is SESSION-RELATIVE (a T+ clock): it never gets a UTC label. */}
      <span className="clock__stream">
        {streamClock
          ? group === 'sim'
            ? t('topbar.clockStreamRelative', { time: streamClock })
            : t('topbar.clockStreamUtc', { time: streamClock })
          : '—'}
      </span>
    </span>
  );
}
