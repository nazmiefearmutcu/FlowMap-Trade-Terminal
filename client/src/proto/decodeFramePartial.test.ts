import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeFrame, decodeFramePartial, ProtocolVersionError, WireError } from './decode';
import { MsgType } from './types';

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'golden');

/** A fresh copy of a server golden vector (tests mutate the bytes). */
function golden(name: string): Uint8Array {
  const b = readFileSync(join(GOLDEN_DIR, `${name}.bin`));
  return new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('decodeFramePartial', () => {
  it('decodes a clean frame with no error', () => {
    const { msgs, error } = decodeFramePartial(golden('cold_hello'));
    expect(error).toBeNull();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe(MsgType.HELLO);
  });

  it('keeps the valid messages in front of a malformed one (the caller routes them)', () => {
    const hello = golden('cold_hello');
    // A cold envelope whose payload_len runs far past the end of the buffer.
    const trailing = new Uint8Array([MsgType.HELLO, 1, 1, 0, 0xff, 0xff, 0xff, 0x7f]);
    const frame = concat(hello, trailing);
    const { msgs, error } = decodeFramePartial(frame);
    expect(msgs).toHaveLength(1);
    expect(error).toBeInstanceOf(WireError);
    // The strict entry point still throws, so existing callers keep their contract.
    expect(() => decodeFrame(frame)).toThrow(WireError);
  });

  it('reports a foreign envelope version as a ProtocolVersionError naming both versions', () => {
    const bytes = golden('cold_hello');
    bytes[1] = 9;
    const { msgs, error } = decodeFramePartial(bytes);
    expect(msgs).toHaveLength(0);
    expect(error).toBeInstanceOf(ProtocolVersionError);
    expect((error as ProtocolVersionError).got).toBe(9);
    expect((error as ProtocolVersionError).expected).toBe(1);
  });
});
