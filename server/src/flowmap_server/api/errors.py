"""Stable, machine-readable REST error codes.

Every REST error leaves the server as ``{"error": {"code", "message"}}`` (see
``api/app.py``). The HTTP status is the coarse class; ``code`` is the contract
the client branches on, so a wording change in ``message`` never breaks it.
Raise :class:`ApiError` where a route knows the precise reason; any other
``HTTPException`` falls back to the status-derived code in ``app.py``.
"""

from __future__ import annotations

from fastapi import HTTPException

__all__ = ["ApiError"]


class ApiError(HTTPException):
    """An HTTP error carrying a stable ``api_code`` next to its message."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(status_code=status_code, detail=message)
        self.api_code = code
