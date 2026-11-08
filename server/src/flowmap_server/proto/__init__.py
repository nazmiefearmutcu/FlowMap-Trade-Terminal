"""FlowMap wire protocol: canonical events (`events`) and framing (`wire`).

The message semantics in this package are authoritative; the docs describe
them for readers. The byte layout in `wire` is mirrored by the
TypeScript client (`client/src/proto/`); golden vectors under
tests/proto/golden/ keep the two implementations in lockstep.
"""

from . import events, wire

__all__ = ["events", "wire"]
