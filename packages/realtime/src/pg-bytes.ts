// Single responsibility: the byte primitives every Postgres frame is built from — big-endian
// integers, NUL-terminated strings, length-prefixed blobs. Shared by the wire framing, the auth
// handshake and the pgoutput decoder so none of them owns a second copy of "read an Int32".
// A read past the end is `X_REPLICATION_PROTOCOL`, never a silent `NaN` or an empty string.

import { ReplicationProtocolError } from './errors';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Cursor over a frame. Every read advances it; overrun throws rather than wrapping around. */
export class ByteReader {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #stage: string;
  #at: number;

  constructor(bytes: Uint8Array, stage = 'decode') {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#stage = stage;
    this.#at = 0;
  }

  get offset(): number {
    return this.#at;
  }

  get remaining(): number {
    return this.#bytes.length - this.#at;
  }

  #need(count: number): number {
    const at = this.#at;
    if (at + count > this.#bytes.length) {
      throw new ReplicationProtocolError({
        stage: this.#stage,
        detail: `a message ended after ${this.#bytes.length} bytes while reading ${count} more at offset ${at}`,
      });
    }
    this.#at = at + count;
    return at;
  }

  uint8(): number {
    return this.#view.getUint8(this.#need(1));
  }

  int16(): number {
    return this.#view.getInt16(this.#need(2), false);
  }

  int32(): number {
    return this.#view.getInt32(this.#need(4), false);
  }

  uint32(): number {
    return this.#view.getUint32(this.#need(4), false);
  }

  int64(): bigint {
    return this.#view.getBigInt64(this.#need(8), false);
  }

  uint64(): bigint {
    return this.#view.getBigUint64(this.#need(8), false);
  }

  /** A single byte as its ASCII character — the tag every Postgres message leads with. */
  tag(): string {
    return String.fromCharCode(this.uint8());
  }

  take(count: number): Uint8Array {
    const at = this.#need(count);
    return this.#bytes.subarray(at, at + count);
  }

  /** The whole tail, without copying. */
  rest(): Uint8Array {
    return this.take(this.remaining);
  }

  utf8(count: number): string {
    return decoder.decode(this.take(count));
  }

  /** NUL-terminated string. A frame that never terminates one is a truncated frame. */
  cstring(): string {
    const end = this.#bytes.indexOf(0, this.#at);
    if (end < 0) {
      throw new ReplicationProtocolError({
        stage: this.#stage,
        detail: `an unterminated string started at offset ${this.#at}`,
      });
    }
    const value = decoder.decode(this.#bytes.subarray(this.#at, end));
    this.#at = end + 1;
    return value;
  }
}

/** Builder for a frame. Grows geometrically; `finish()` hands back exactly the bytes written. */
export class ByteWriter {
  #bytes: Uint8Array;
  #dataView: DataView;
  #at = 0;

  constructor(capacity = 128) {
    this.#bytes = new Uint8Array(capacity);
    this.#dataView = new DataView(this.#bytes.buffer);
  }

  get length(): number {
    return this.#at;
  }

  /** Reserves `count` bytes and returns where they start — growing, and re-viewing, if needed. */
  #room(count: number): number {
    const at = this.#at;
    if (at + count > this.#bytes.length) {
      const grown = new Uint8Array(Math.max(this.#bytes.length * 2, at + count));
      grown.set(this.#bytes.subarray(0, at));
      this.#bytes = grown;
      this.#dataView = new DataView(grown.buffer);
    }
    this.#at = at + count;
    return at;
  }

  uint8(value: number): this {
    this.#bytes[this.#room(1)] = value & 0xff;
    return this;
  }

  int16(value: number): this {
    // `#room` may replace the buffer, so the offset is taken before the view is touched.
    const at = this.#room(2);
    this.#dataView.setInt16(at, value, false);
    return this;
  }

  int32(value: number): this {
    const at = this.#room(4);
    this.#dataView.setInt32(at, value, false);
    return this;
  }

  int64(value: bigint): this {
    const at = this.#room(8);
    this.#dataView.setBigInt64(at, value, false);
    return this;
  }

  raw(bytes: Uint8Array): this {
    const at = this.#room(bytes.length);
    this.#bytes.set(bytes, at);
    return this;
  }

  utf8(value: string): this {
    return this.raw(encoder.encode(value));
  }

  cstring(value: string): this {
    return this.utf8(value).uint8(0);
  }

  finish(): Uint8Array {
    return this.#bytes.slice(0, this.#at);
  }
}

/** `0/16B3748` — how Postgres prints an LSN on the wire and in `pg_replication_slots`. */
export const printLsn = (position: bigint): string =>
  `${(position >> 32n).toString(16).toUpperCase()}/${(position & 0xffffffffn).toString(16).toUpperCase()}`;

/** Postgres timestamps in the replication stream are µs since 2000-01-01, not the Unix epoch. */
export const PG_EPOCH_MS = 946_684_800_000;

export const pgTimestampToEpochMs = (micros: bigint): number =>
  Number(micros / 1000n) + PG_EPOCH_MS;

export const epochMsToPgTimestamp = (epochMs: number): bigint =>
  BigInt(Math.trunc(epochMs) - PG_EPOCH_MS) * 1000n;
