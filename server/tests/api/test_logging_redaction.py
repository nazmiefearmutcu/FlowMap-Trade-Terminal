"""Session tokens in URL query strings never reach the log file.

uvicorn logs the raw WebSocket path (``/ws?token=<hex>``) on every handshake.
The admission handler must scrub that value before the record is queued.
"""

from __future__ import annotations

import logging
import re

from starlette.testclient import TestClient

from flowmap_server import logging_setup as setup
from flowmap_server.api import _env
from flowmap_server.api.app import create_app
from flowmap_server.config import Config

TOKEN = "9f" * 32
HEX64 = re.compile(r"[0-9a-fA-F]{64}")


class _Sink:
    def __init__(self) -> None:
        self.records: list[logging.LogRecord] = []

    def enqueue(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _uvicorn_accepted(path: str) -> logging.LogRecord:
    return logging.LogRecord(
        "uvicorn.error",
        logging.INFO,
        __file__,
        1,
        '%s - "WebSocket %s" [accepted]',
        ("127.0.0.1:5000", path),
        None,
    )


def test_redact_secrets_scrubs_only_the_token_value() -> None:
    text = f"/ws?token={TOKEN}&limit=5"
    assert setup.redact_secrets(text) == "/ws?token=***&limit=5"
    assert setup.redact_secrets("max_token=keep") == "max_token=keep"
    assert setup.redact_secrets("no credential here") == "no credential here"


def test_uvicorn_handshake_line_has_no_token_in_queued_record() -> None:
    sink = _Sink()
    handler = setup._Admission(sink)  # type: ignore[arg-type]
    original = _uvicorn_accepted(f"/ws?token={TOKEN}")

    # handle() runs the handler's redaction filter before emit().
    handler.handle(original)

    assert len(sink.records) == 1
    rendered = sink.records[0].getMessage()
    assert TOKEN not in rendered
    assert not HEX64.search(rendered)
    assert rendered.endswith('"WebSocket /ws?token=***" [accepted]')
    # The producer's own record is left as the caller created it.
    assert TOKEN in original.getMessage()


def test_token_filter_returns_a_redacted_copy_for_any_uvicorn_logger() -> None:
    record = _uvicorn_accepted(f"/ws?token={TOKEN}")
    redacted = setup.TokenRedactionFilter().filter(record)
    assert isinstance(redacted, logging.LogRecord) and redacted is not record
    assert redacted.getMessage().endswith('"WebSocket /ws?token=***" [accepted]')
    assert TOKEN in record.getMessage()
    plain = _uvicorn_accepted("/ws?limit=5")
    assert setup.TokenRedactionFilter().filter(plain).getMessage().endswith('"WebSocket /ws?limit=5" [accepted]')


def test_token_in_message_template_and_dict_args_is_scrubbed() -> None:
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        __file__,
        1,
        f"GET /ws?token={TOKEN} done",
        None,
        None,
    )
    setup.redact_record(record)
    assert TOKEN not in record.getMessage()

    dict_record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1,
                                    "%(path)s", None, None)
    dict_record.args = {"path": f"/ws?token={TOKEN}"}
    setup.redact_record(dict_record)
    assert dict_record.getMessage() == "/ws?token=***"


def test_non_token_arguments_pass_through_unchanged() -> None:
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "%s %d", ("a", 3), None)
    setup.redact_record(record)
    assert record.getMessage() == "a 3"


def test_websocket_handshake_with_query_token_leaves_no_token_in_admitted_logs(tmp_path, monkeypatch):
    monkeypatch.setenv(_env.ENV_SESSION_TOKEN, TOKEN)
    app = create_app(Config(data_dir=str(tmp_path / "rec"), recording_enabled=False))
    sink = _Sink()
    handler = setup._Admission(sink)  # type: ignore[arg-type]
    loggers = [logging.getLogger("uvicorn.access"), logging.getLogger("uvicorn.error")]
    levels = [logger.level for logger in loggers]
    for logger in loggers:
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
    try:
        path = f"/ws?token={TOKEN}"
        with TestClient(app).websocket_connect(path):
            # uvicorn writes the raw handshake path, query included, for every socket.
            logging.getLogger("uvicorn.access").info(
                '%s - "WebSocket %s" [accepted]', "127.0.0.1:5000", path)
    finally:
        for logger, level in zip(loggers, levels):
            logger.removeHandler(handler)
            logger.setLevel(level)
    rendered = [record.getMessage() for record in sink.records]
    assert rendered, "the handshake line must reach the admission handler"
    for line in rendered:
        assert TOKEN not in line
        assert not HEX64.search(line)
    assert rendered[0].endswith('"WebSocket /ws?token=***" [accepted]')
