"""Hostile-input guards for the wire decoder.

A HISTORY_RESP nests whole messages. Before the guard, a crafted frame that
nested HISTORY_RESP inside HISTORY_RESP recursed through ``decode`` until
Python's recursion limit, and ``RecursionError`` escaped the ``ValueError``
taxonomy the WS layer catches. These tests pin the ``ValueError`` contract.
"""

import struct

import pytest

from flowmap_server.proto import wire


def _history_frame(counts: tuple[int, int, int, int], body: bytes) -> bytes:
    header = struct.pack("<IIqHHHH", 1, 0, 0, *counts)
    return wire._frame(wire.MSG_HISTORY_RESP, header + body)


def test_nested_history_resp_is_refused_as_value_error():
    inner = _history_frame((0, 0, 0, 0), b"")
    outer = _history_frame((1, 0, 0, 0), inner)
    with pytest.raises(ValueError, match="nested HISTORY_RESP"):
        wire.decode(outer)


def test_deeply_nested_history_resp_raises_value_error_not_recursion_error():
    # Built bottom-up so the input itself is cheap to construct: each level is
    # a HISTORY_RESP whose single depth entry is the level below it. 5000 levels
    # is far past Python's default recursion limit.
    frame = _history_frame((0, 0, 0, 0), b"")
    for _ in range(5000):
        frame = _history_frame((1, 0, 0, 0), frame)
    with pytest.raises(ValueError):
        wire.decode(frame)


def test_version_mismatch_raises_typed_error_carrying_versions():
    # A PING envelope stamped with a version this build does not speak.
    buf = struct.pack("<BBHI", wire.MSG_PING, wire.PROTO_VER + 1, 0, 8) + struct.pack("<q", 7)
    with pytest.raises(wire.ProtocolVersionError) as info:
        wire.decode(buf)
    assert isinstance(info.value, ValueError)
    assert info.value.got == wire.PROTO_VER + 1
    assert info.value.expected == wire.PROTO_VER


def test_legitimate_history_response_still_decodes():
    from flowmap_server.proto import events

    ev = events.HistoryResponse(req_id=9, epoch=2, oldest_available_t_ns=5,
                                depth_cols=[], bar_cols=[], markers=[], big_trades=[])
    out, nxt = wire.decode(wire.encode(ev))
    assert out.req_id == 9 and out.epoch == 2
    assert nxt == len(wire.encode(ev))
