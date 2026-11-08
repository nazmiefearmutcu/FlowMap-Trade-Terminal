"""Environment parsing consistency: booleans fail closed on a
typo, decimal commas are read, every knob error names its variable, the column
cadence has a 1 ms floor and the config repr never prints a key."""

from __future__ import annotations

import pytest

from flowmap_server.config import Config


@pytest.mark.parametrize("word", ["0", "false", "FALSE", "off", "OFF", "no", " 0 "])
def test_recording_can_be_switched_off_by_any_common_spelling(word):
    assert Config.from_env({"FLOWMAP_RECORDING_ENABLED": word}).recording_enabled is False
    assert Config.from_env({"FLOWMAP_BACKFILL_ENABLED": word}).backfill_enabled is False


@pytest.mark.parametrize("word", ["1", "true", "TRUE", "on", "yes"])
def test_recording_can_be_switched_on(word):
    assert Config.from_env({"FLOWMAP_RECORDING_ENABLED": word}).recording_enabled is True


def test_an_unknown_boolean_word_is_refused_naming_the_variable():
    with pytest.raises(ValueError) as refused:
        Config.from_env({"FLOWMAP_RECORDING_ENABLED": "maybe"})
    assert "FLOWMAP_RECORDING_ENABLED" in str(refused.value)


def test_decimal_comma_is_read_as_the_decimal_separator():
    assert Config.from_env({"FLOWMAP_RECORDING_GB_CAP": "20,0"}).recording_gb_cap == 20.0
    assert Config.from_env({"FLOWMAP_CRYPTO_TICK": "0,5"}).crypto_tick == 0.5
    assert Config.from_env({"FLOWMAP_RECORDING_GB_CAP": "20.5"}).recording_gb_cap == 20.5


def test_crypto_tick_errors_name_the_variable():
    with pytest.raises(ValueError) as refused:
        Config.from_env({"FLOWMAP_CRYPTO_TICK": "abc"})
    assert "FLOWMAP_CRYPTO_TICK" in str(refused.value)
    with pytest.raises(ValueError) as negative:
        Config.from_env({"FLOWMAP_CRYPTO_TICK": "-1"})
    assert "FLOWMAP_CRYPTO_TICK" in str(negative.value)


def test_a_one_nanosecond_column_cadence_is_refused():
    with pytest.raises(ValueError) as refused:
        Config.from_env({"FLOWMAP_DT_CRYPTO_NS": "1"})
    assert "FLOWMAP_DT_CRYPTO_NS" in str(refused.value)
    assert Config.from_env({"FLOWMAP_DT_CRYPTO_NS": "1000000"}).dt_crypto_ns == 1_000_000


def test_repr_never_prints_exchange_or_provider_keys():
    cfg = Config.from_env({
        "ALPACA_API_KEY": "ALPACA-SECRET-KEY-123",
        "ALPACA_API_SECRET": "ALPACA-SECRET-VALUE-456",
        "FINNHUB_API_KEY": "FINNHUB-SECRET-789",
    })
    text = repr(cfg)
    assert "ALPACA-SECRET" not in text and "FINNHUB-SECRET" not in text
    assert "alpaca_key=***" in text and "finnhub_key=***" in text
    assert "port=8720" in text  # ordinary fields stay readable


def test_an_empty_finnhub_key_is_no_key():
    assert Config.from_env({"FINNHUB_API_KEY": ""}).finnhub_key is None
    assert Config.from_env({"FINNHUB_API_KEY": "k"}).finnhub_key == "k"


def test_an_empty_data_dir_means_the_default_not_the_working_directory():
    from pathlib import Path

    default = str(Path("~/.flowmap/recordings").expanduser())
    assert Config.from_env({"FLOWMAP_DATA_DIR": ""}).data_dir == default
    assert Config.from_env({}).data_dir == default
    assert Config.from_env({"FLOWMAP_DATA_DIR": "~/x"}).data_dir == str(Path("~/x").expanduser())
