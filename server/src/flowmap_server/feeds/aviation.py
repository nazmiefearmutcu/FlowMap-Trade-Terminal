"""OpenSky positions for a caller-supplied, verified aircraft registry.

ADS-B positions do not establish executive travel, destination or deal intent.
No corporate-to-aircraft mapping is assumed by default.
"""

from __future__ import annotations

from decimal import Decimal
import logging
import math
import re
import time
from typing import Any

import aiohttp

from flowmap_server import __version__

log = logging.getLogger(__name__)
_OPENSKY_API_URL = 'https://opensky-network.org/api/states/all'


def _finite_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class CorporateJetTracker:
    """Read ADS-B state vectors only for explicitly supplied registry entries."""

    def __init__(self, verified_registry: dict[str, dict[str, str]] | None = None) -> None:
        self.registry: dict[str, dict[str, str]] = {}
        for icao, info in (verified_registry or {}).items():
            if not re.fullmatch(r'[0-9a-fA-F]{6}', icao):
                raise ValueError('aircraft registry requires six-digit ICAO identifiers')
            if not all(isinstance(info.get(key), str) and info[key].strip() for key in ('symbol', 'company', 'tail')):
                raise ValueError('aircraft registry requires verified symbol, company and tail')
            self.registry[icao.lower()] = dict(info)
        self._session: aiohttp.ClientSession | None = None
        # Per registry entry, the outcome of the latest pass.
        self.last_status: dict[str, dict[str, Any]] = {}

    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(headers={'User-Agent': f'FlowMap-AeroTracker/{__version__}'})
        return self._session

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def check_aircraft_states(self) -> list[dict[str, Any]]:
        """Return fresh, valid matched source positions with the source position clock.

        ``last_status`` records, per registry entry, whether the query succeeded.
        A rate limit or outage is then not the same as "no aircraft airborne".
        """
        self.last_status = {}
        if not self.registry:
            return []
        session = await self._get_session()
        events: list[dict[str, Any]] = []
        for icao, info in self.registry.items():
            try:
                async with session.get(_OPENSKY_API_URL, params={'icao24': icao}, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                    if resp.status != 200:
                        self.last_status[icao] = {'ok': False, 'reason': _opensky_reason(resp.status),
                                                  'http_status': resp.status}
                        log.warning('OpenSky returned HTTP %s for registry entry %s', resp.status, icao)
                        if resp.status == 429:
                            # Stop this pass: further queries would only deepen the rate limit.
                            break
                        continue
                    data = await resp.json()
                    states = data.get('states') if isinstance(data, dict) else None
                    if not isinstance(states, list):
                        self.last_status[icao] = {'ok': False, 'reason': 'malformed_response', 'http_status': 200}
                        continue
                    received_at_ns = time.time_ns()
                    stale = 0
                    produced = False
                    for state in states:
                        if not isinstance(state, (list, tuple)) or len(state) < 10 or str(state[0]).lower() != icao:
                            continue
                        position_time, lon, lat = state[3], state[5], state[6]
                        if (not all(_finite_number(value) for value in (position_time, lon, lat))
                                or position_time <= 0 or not -180 <= lon <= 180 or not -90 <= lat <= 90):
                            continue
                        source_ns = int(Decimal(str(position_time)) * 1_000_000_000)
                        if source_ns <= 0 or source_ns > 2**63 - 1:
                            continue
                        if received_at_ns - source_ns > MAX_POSITION_AGE_NS:
                            # An old position still carries its last airborne/on-ground flag.
                            stale += 1
                            continue
                        produced = True
                        altitude = state[7] if _finite_number(state[7]) else None
                        on_ground = state[8] if isinstance(state[8], bool) else None
                        velocity = state[9] if _finite_number(state[9]) and state[9] >= 0 else None
                        events.append({
                            'ts_ns': source_ns, 'received_at_ns': received_at_ns,
                            'source': 'OpenSky ADS-B state vector',
                            'registry_source': 'caller-supplied verified registry',
                            'icao24': icao, 'symbol': info['symbol'], 'company': info['company'],
                            'tail': info['tail'], 'lat': lat, 'lon': lon,
                            'altitude_m': altitude, 'on_ground': on_ground, 'velocity_mps': velocity,
                            'status': 'On ground' if on_ground is True else 'Airborne' if on_ground is False else 'Position observed',
                        })
                    self.last_status[icao] = {
                        'ok': True, 'http_status': 200,
                        'reason': None if produced else ('stale_positions_only' if stale else 'no_state'),
                        'stale_states': stale,
                    }
            except Exception as exc:
                self.last_status[icao] = {'ok': False, 'reason': 'unreachable', 'http_status': None}
                log.warning('OpenSky query for %s failed: %s', icao, exc)
        return events


# A position older than this is not reported as current telemetry.
MAX_POSITION_AGE_NS = 15 * 60 * 1_000_000_000


def _opensky_reason(status: int) -> str:
    if status == 429:
        return 'rate_limited'
    return f'http_{status}'