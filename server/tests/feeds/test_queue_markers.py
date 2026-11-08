"""Backpressure must not silently erase gap, halt or session markers."""

from flowmap_server.feeds.base import BoundedFeedQueue
from flowmap_server.proto.events import SIDE_BUY, SIDE_SRC_EXCHANGE, Marker, Trade


def _trade(i: int) -> Trade:
    return Trade(ts_ns=i + 1, price=float(i), size=1.0, side=SIDE_BUY,
                 side_src=SIDE_SRC_EXCHANGE, venue="t")


def _gap(i: int) -> Marker:
    return Marker(ts_ns=i + 1, kind="gap", text=f"gap {i}")


async def test_a_gap_marker_survives_when_trades_can_be_dropped_instead():
    q = BoundedFeedQueue(3)
    q.put_nowait(_gap(0))  # oldest item is a marker
    q.put_nowait(_trade(1))
    q.put_nowait(_trade(2))
    q.put_nowait(_trade(3))  # full: a trade is dropped, not the marker
    assert q.dropped == 1 and q.markers_dropped == 0
    survivors = [await q.get() for _ in range(3)]
    assert isinstance(survivors[0], Marker) and survivors[0].text == "gap 0"
    assert [t.price for t in survivors[1:]] == [2.0, 3.0]


async def test_a_queue_of_only_markers_still_bounds_memory_and_counts_the_loss():
    q = BoundedFeedQueue(2)
    for i in range(4):
        q.put_nowait(_gap(i))
    assert q.qsize() == 2 and q.dropped == 2 and q.markers_dropped == 2
    assert await q.get() == _gap(2)
    assert await q.get() == _gap(3)


async def test_get_waits_for_a_later_put():
    import asyncio

    q = BoundedFeedQueue(4)

    async def producer():
        await asyncio.sleep(0.01)
        q.put_nowait(_trade(7))

    task = asyncio.create_task(producer())
    item = await asyncio.wait_for(q.get(), 1.0)
    await task
    assert item.price == 7.0
