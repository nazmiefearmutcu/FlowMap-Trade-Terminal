"""The entrypoint honours every spelling the config parser accepts for stdin EOF.

The EOF watcher used to start only for the exact string "1", while the app
lifespan honoured every truthy spelling. Both now follow the parsed flag.
"""

from __future__ import annotations

import pytest

from flowmap_server import __main__ as entry


@pytest.mark.parametrize(("spelling", "expected"), [("1", True), ("true", True), ("0", False)])
def test_entrypoint_passes_the_parsed_stdin_eof_flag(monkeypatch, spelling, expected):
    seen: dict[str, object] = {}
    monkeypatch.setattr(entry, "_run_server", lambda app, **kwargs: seen.update(kwargs))
    monkeypatch.setattr(entry, "create_app", lambda cfg: object())
    monkeypatch.setattr(entry, "configure_logging", lambda *args, **kwargs: None)
    monkeypatch.setattr(entry, "shutdown_logging", lambda: None)
    monkeypatch.delenv("FLOWMAP_BENCHMARK_PROVENANCE", raising=False)
    monkeypatch.setenv(entry.EXIT_ON_STDIN_EOF_ENV, spelling)

    entry.main()

    assert seen["exit_on_stdin_eof"] is expected
