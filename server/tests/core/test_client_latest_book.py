"""A full instant-book state supersedes the queued one for the same client.

A client that stops reading must not be sent a backlog of stale full-grid book
frames in order. Each book frame is a complete picture, so only the newest one
is worth delivering, the same latest-wins rule the partial columns already follow.
"""

from __future__ import annotations

from flowmap_server.core.session_queue import ClientTx

_BIG = 1 << 20


def test_a_lagged_client_holds_only_the_latest_instant_book():
    client = ClientTx()
    for i in range(5):
        client.offer(f"book-{i}".encode(), col_msg=False, latest_key="instant-book")

    assert len(client) == 1
    assert client.drain(_BIG) == [b"book-4"]


def test_other_frames_keep_their_order_around_the_latest_book():
    client = ClientTx()
    client.offer(b"trade-0", col_msg=False)
    client.offer(b"book-0", col_msg=False, latest_key="instant-book")
    client.offer(b"trade-1", col_msg=False)
    client.offer(b"book-1", col_msg=False, latest_key="instant-book")

    assert client.drain(_BIG) == [b"trade-0", b"trade-1", b"book-1"]


def test_superseded_books_do_not_count_toward_the_noncolumn_cap():
    client = ClientTx(noncol_cap=3)
    for i in range(5):
        client.offer(f"book-{i}".encode(), col_msg=False, latest_key="instant-book")
    client.offer(b"trade-0", col_msg=False)
    client.offer(b"trade-1", col_msg=False)

    assert client.drain(_BIG) == [b"book-4", b"trade-0", b"trade-1"]
