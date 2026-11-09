"""The shared finite-number guard admits real finite readings and nothing else."""

from __future__ import annotations

import math

import pytest

from flowmap_server.feeds._numeric import finite_number


@pytest.mark.parametrize("value", [0, -1, 2.5, 1e308, -0.0])
def test_finite_int_and_float_readings_are_accepted(value: float) -> None:
    assert finite_number(value) is True


@pytest.mark.parametrize("value", [True, False, math.nan, math.inf, -math.inf, None, "1.0", [1.0]])
def test_bools_non_finite_values_and_non_numbers_are_rejected(value: object) -> None:
    assert finite_number(value) is False
