import { describe, expect, test } from 'bun:test';
import { ReplicationProtocolError } from './errors';
import {
  ByteReader,
  ByteWriter,
  epochMsToPgTimestamp,
  pgTimestampToEpochMs,
  printLsn,
} from './pg-bytes';

describe('ByteWriter / ByteReader', () => {
  test('round-trips every primitive the wire uses, big-endian', () => {
    const bytes = new ByteWriter(4)
      .uint8(0x77)
      .int16(-2)
      .int32(196_608)
      .int64(0x0000_0001_16b3_748n)
      .cstring('publication')
      .raw(new Uint8Array([1, 2, 3]))
      .finish();

    const reader = new ByteReader(bytes);
    expect(reader.tag()).toBe('w');
    expect(reader.int16()).toBe(-2);
    expect(reader.int32()).toBe(196_608);
    expect(reader.int64()).toBe(0x0000_0001_16b3_748n);
    expect(reader.cstring()).toBe('publication');
    expect([...reader.rest()]).toEqual([1, 2, 3]);
    expect(reader.remaining).toBe(0);
  });

  test('grows past its initial capacity without corrupting earlier writes', () => {
    const writer = new ByteWriter(2);
    for (let i = 0; i < 300; i += 1) writer.uint8(i & 0xff);
    const bytes = writer.finish();
    expect(bytes.length).toBe(300);
    expect(bytes[0]).toBe(0);
    expect(bytes[299]).toBe(299 & 0xff);
  });

  test('int32 is signed and uint32 is not — the same four bytes, two answers', () => {
    const bytes = new ByteWriter().int32(-1).int32(-1).finish();
    const reader = new ByteReader(bytes);
    expect(reader.int32()).toBe(-1);
    expect(reader.uint32()).toBe(4_294_967_295);
  });

  test('utf8 survives multi-byte characters in both directions', () => {
    const bytes = new ByteWriter().cstring('café ☕').finish();
    expect(new ByteReader(bytes).cstring()).toBe('café ☕');
  });

  test('reading past the end is X_REPLICATION_PROTOCOL, not NaN', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]), 'relation');
    expect(() => reader.int32()).toThrow(ReplicationProtocolError);
    expect(() => reader.int32()).toThrow(/relation/);
  });

  test('an unterminated string is a truncated frame, not an empty value', () => {
    const reader = new ByteReader(new Uint8Array([0x61, 0x62]));
    expect(() => reader.cstring()).toThrow(ReplicationProtocolError);
  });

  test('reads respect a subarray view rather than the whole backing buffer', () => {
    const backing = new Uint8Array([9, 9, 0, 0, 0, 7, 9]);
    const reader = new ByteReader(backing.subarray(2, 6));
    expect(reader.int32()).toBe(7);
    expect(reader.remaining).toBe(0);
  });
});

describe('lsn and timestamp printing', () => {
  test('printLsn produces the two-halves hex form postgres uses', () => {
    expect(printLsn(0n)).toBe('0/0');
    expect(printLsn((1n << 32n) | 0x16b3748n)).toBe('1/16B3748');
  });

  test('pg timestamps are microseconds since 2000-01-01, not the unix epoch', () => {
    const epochMs = Date.UTC(2026, 7, 9, 12, 0, 0);
    expect(pgTimestampToEpochMs(epochMsToPgTimestamp(epochMs))).toBe(epochMs);
    expect(pgTimestampToEpochMs(0n)).toBe(Date.UTC(2000, 0, 1));
  });
});

describe('the cursor is the reader, not a side effect of the reads', () => {
  test('offset advances by exactly the width of each read, and remaining mirrors it', () => {
    const bytes = new ByteWriter(4).uint8(1).int16(2).int32(3).int64(4n).finish();
    const reader = new ByteReader(bytes);

    expect(reader.offset).toBe(0);
    reader.uint8();
    expect(reader.offset).toBe(1);
    reader.int16();
    expect(reader.offset).toBe(3);
    reader.int32();
    expect(reader.offset).toBe(7);
    reader.int64();
    expect(reader.offset).toBe(15);
    expect(reader.offset + reader.remaining).toBe(bytes.length);
  });

  test('a read that overruns leaves the cursor where it was and names the offset', () => {
    const reader = new ByteReader(new Uint8Array([1, 2]), 'copy-data');
    reader.uint8();
    let cause = '';
    try {
      reader.int32();
    } catch (error) {
      cause = error instanceof ReplicationProtocolError ? error.cause : String(error);
    }
    expect(cause).toContain('offset 1');
    expect(reader.offset).toBe(1);
  });
});

describe('uint64', () => {
  test('reads an LSN above the signed range as a positive bigint, where int64 goes negative', () => {
    // A wal position with the high bit set: `int64` would answer a negative number, and every
    // comparison built on it (gap detection, `printLsn`) would then order it before zero.
    const bytes = new ByteWriter(8).int64(-1n).finish();
    expect(new ByteReader(bytes).uint64()).toBe(0xffff_ffff_ffff_ffffn);
    expect(new ByteReader(bytes).int64()).toBe(-1n);
  });

  test('advances eight bytes and refuses a short frame', () => {
    const reader = new ByteReader(new ByteWriter(8).int64(7n).finish());
    expect(reader.uint64()).toBe(7n);
    expect(reader.offset).toBe(8);
    expect(() => new ByteReader(new Uint8Array(7)).uint64()).toThrow(ReplicationProtocolError);
  });
});

describe('ByteWriter.length', () => {
  test('counts bytes written, not the capacity it reserved', () => {
    const writer = new ByteWriter(128);
    expect(writer.length).toBe(0);
    writer.uint8(1);
    expect(writer.length).toBe(1);
    writer.int32(2);
    expect(writer.length).toBe(5);
    writer.cstring('ab');
    expect(writer.length).toBe(8);
    expect(writer.finish().length).toBe(writer.length);
  });

  test('keeps counting across a growth, which is the case a capacity would have hidden', () => {
    const writer = new ByteWriter(4);
    writer.raw(new Uint8Array(10));
    expect(writer.length).toBe(10);
    expect(writer.finish().length).toBe(10);
  });
});
