"""Numeric guards shared by the feed parsers."""

from __future__ import annotations

import math
from typing import TypeGuard


def finite_number(value: object) -> TypeGuard[float | int]:
    """True for a finite int or float. A bool, NaN or infinity is not a reading."""
    return isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value)
