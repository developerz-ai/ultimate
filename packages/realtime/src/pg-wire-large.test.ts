// One large CopyData message, arriving the way a socket hands it over: in 64 kB chunks. The reader
// re-copied everything it held on every chunk — quadratic, measured at 5.2 s of blocked event loop
// for one 32 MB message on the replication connection every live window depends on.

import { describe, expect, test } from 'bun:test';
import { MessageReader, type PgStream } from './pg-wire';

const CHUNK = 64 * 1024;

/** A `d` message of `size` body bytes, each byte its offset mod 251, then a `Z` behind it. */
function wire(size: number): Uint8Array {
  const bytes = new Uint8Array(size + 5 + 6);
  const view = new DataView(bytes.buffer);
  bytes[0] = 'd'.charCodeAt(0);
  view.setInt32(1, size + 4, false);
  for (let i = 0; i < size; i += 1) bytes[5 + i] = i % 251;
  bytes[size + 5] = 'Z'.charCodeAt(0);
  view.setInt32(size + 6, 5, false);
  bytes[size + 10] = 'I'.charCodeAt(0);
  return bytes;
}

function chunked(bytes: Uint8Array, size: number): PgStream {
  let at = 0;
  return {
    read: async () => {
      if (at >= bytes.length) return undefined;
      const chunk = bytes.slice(at, at + size);
      at += size;
      return chunk;
    },
    write: async () => undefined,
    close: () => undefined,
  };
}

describe('a large message read in socket-sized chunks', () => {
  test('arrives whole, byte for byte, with the message behind it intact', async () => {
    const size = 3 * CHUNK + 17;
    const reader = new MessageReader(chunked(wire(size), 1_000));
    const first = await reader.next();
    expect(first?.tag).toBe('d');
    expect(first?.body.length).toBe(size);
    expect(first?.body[0]).toBe(0);
    expect(first?.body[size - 1]).toBe((size - 1) % 251);
    const second = await reader.next();
    expect(second?.tag).toBe('Z');
    expect([...(second?.body ?? [])]).toEqual(['I'.charCodeAt(0)]);
    expect(await reader.next()).toBeUndefined();
  });

  test('a header split across chunks, and a chunk carrying the tail and the next message', async () => {
    const bytes = wire(10);
    for (const size of [1, 2, 3, 4, 7, 16]) {
      const reader = new MessageReader(chunked(bytes, size));
      expect((await reader.next())?.body.length).toBe(10);
      expect((await reader.next())?.tag).toBe('Z');
      expect(await reader.next()).toBeUndefined();
    }
  });

  test('32 MB in 64 kB chunks is copied once, not once per chunk', async () => {
    const size = 32 * 1024 * 1024;
    const reader = new MessageReader(chunked(wire(size), CHUNK));
    const started = performance.now();
    const message = await reader.next();
    const elapsed = performance.now() - started;
    expect(message?.body.length).toBe(size);
    // Measured: the quadratic reader took seconds here; a single copy takes tens of ms. The bound
    // is loose on purpose — it separates O(n) from O(n²), never one machine from another.
    expect(elapsed).toBeLessThan(1_000);
  });
});
