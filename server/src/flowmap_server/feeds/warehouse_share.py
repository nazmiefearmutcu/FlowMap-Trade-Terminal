"""One process-wide DuckWarehouse for the intelligence collectors.

Darkpool, capitol, contracts and macro share one DuckDB handle when built without
an explicit warehouse, so they do not each open their own connection. The handle
is closed at interpreter exit. The collectors write from the
event-loop thread, so the single DuckDB connection is never used concurrently.
"""

from __future__ import annotations

import atexit
import threading

from flowmap_server.data.warehouse import DuckWarehouse

__all__ = ["close_shared_warehouse", "shared_warehouse"]

_lock = threading.Lock()
_shared: DuckWarehouse | None = None


def shared_warehouse() -> DuckWarehouse:
    """Return the process-wide warehouse, opening it on first use."""
    global _shared
    with _lock:
        if _shared is None:
            _shared = DuckWarehouse()
            atexit.register(close_shared_warehouse)
        return _shared


def close_shared_warehouse() -> None:
    """Close the shared warehouse if it is open; the next call reopens it."""
    global _shared
    with _lock:
        handle, _shared = _shared, None
    if handle is not None:
        handle.close()
