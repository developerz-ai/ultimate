// Single responsibility: the one scripted walsender this package's replication tests run against —
// pgoutput message builders, a fake `PgStream` that answers the exact preflight sequence, and the
// `start()` that boots a feed over it. Kept out of the test file so neither outgrows its ceiling.
// Not part of the public API — `index.ts` deliberately does not re-export it.

import { frozenClock } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { PgLogicalReplicationFeed } from './changefeed';
import { ByteReader, ByteWriter, pgTimestampToEpochMs } from './pg-bytes';
import type { PgStream } from './pg-wire';
import { frame } from './pg-wire';

// ---- pgoutput fixtures ------------------------------------------------------------------------

export const POSTS_OID = 16_384;
export const OTHER_OID = 16_385;
export const TEXT = 25;
export const INT8 = 20;

export interface FixtureColumn {
  readonly name: string;
  readonly key?: boolean;
  /** Type oid, `TEXT` unless a case is specifically about how another type decodes. */
  readonly type?: number;
}

export const relation = (
  oid: number,
  name: string,
  columns: readonly FixtureColumn[],
): Uint8Array => {
  const writer = new ByteWriter()
    .uint8(0x52)
    .int32(oid)
    .cstring('public')
    .cstring(name)
    .uint8(0x66)
    .int16(columns.length);
  for (const column of columns) {
    writer
      .uint8(column.key === true ? 1 : 0)
      .cstring(column.name)
      .int32(column.type ?? TEXT)
      .int32(-1);
  }
  return writer.finish();
};

export const tuple = (writer: ByteWriter, values: readonly (string | null)[]): ByteWriter => {
  writer.int16(values.length);
  for (const value of values) {
    if (value === null) writer.uint8(0x6e);
    else writer.uint8(0x74).int32(value.length).utf8(value);
  }
  return writer;
};

export const begin = (commitLsn: bigint, at: bigint, xid: number): Uint8Array =>
  new ByteWriter().uint8(0x42).int64(commitLsn).int64(at).int32(xid).finish();

export const commit = (commitLsn: bigint, endLsn: bigint, at: bigint): Uint8Array =>
  new ByteWriter().uint8(0x43).uint8(0).int64(commitLsn).int64(endLsn).int64(at).finish();

export const insert = (oid: number, values: readonly (string | null)[]): Uint8Array =>
  tuple(new ByteWriter().uint8(0x49).int32(oid).uint8(0x4e), values).finish();

export const update = (
  oid: number,
  before: readonly (string | null)[] | null,
  after: readonly (string | null)[],
): Uint8Array => {
  const writer = new ByteWriter().uint8(0x55).int32(oid);
  if (before !== null) tuple(writer.uint8(0x4f), before);
  return tuple(writer.uint8(0x4e), after).finish();
};

export const remove = (oid: number, before: readonly (string | null)[]): Uint8Array =>
  tuple(new ByteWriter().uint8(0x44).int32(oid).uint8(0x4f), before).finish();

/** `w` XLogData, wrapped as the `d` CopyData message the walsender sends it in. */
export const xlog = (payload: Uint8Array, walEnd = 0n): Uint8Array =>
  frame(
    'd',
    new ByteWriter().uint8(0x77).int64(walEnd).int64(walEnd).int64(0n).raw(payload).finish(),
  );

export const keepalive = (walEnd: bigint, replyRequested: number): Uint8Array =>
  frame('d', new ByteWriter().uint8(0x6b).int64(walEnd).int64(0n).uint8(replyRequested).finish());

/** `c` CopyDone — the walsender ending the stream politely. It is still the stream ending. */
export const copyDone = (): Uint8Array => frame('c', new Uint8Array(0));

// ---- a scripted walsender ---------------------------------------------------------------------

export const dataRow = (values: readonly (string | null)[]): Uint8Array => {
  const writer = new ByteWriter().int16(values.length);
  for (const value of values) {
    if (value === null) writer.int32(-1);
    else writer.int32(value.length).utf8(value);
  }
  return frame('D', writer.finish());
};

export const ready = (): Uint8Array => frame('Z', new Uint8Array([0x49]));
export const complete = (): Uint8Array => frame('C', new ByteWriter().cstring('SELECT 1').finish());

export const joined = (...parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

export interface ServerScript {
  readonly walLevel?: string;
  readonly publicationExists?: boolean;
  /** `null` = no slot yet, so the feed has to create one. */
  readonly slotPlugin?: string | null;
}

/**
 * Answers the exact command sequence the feed issues, and records what it sent back — enough to
 * drive the whole preflight and then inject WAL by hand.
 */
export class FakeWalsender implements PgStream {
  readonly queries: string[] = [];
  readonly standby: { position: bigint; at: number }[] = [];
  closed = false;
  // `undefined` is EOF: `PgStream.read()` already returns `Uint8Array | undefined`, so the queue
  // holds it honestly rather than letting `close()` cast one type into the other.
  readonly #chunks: (Uint8Array | undefined)[] = [];
  readonly #script: ServerScript;
  #waiting: ((chunk: Uint8Array | undefined) => void) | null = null;

  constructor(script: ServerScript = {}) {
    this.#script = script;
  }

  push(chunk: Uint8Array | undefined): void {
    const waiter = this.#waiting;
    this.#waiting = null;
    if (waiter === null) this.#chunks.push(chunk);
    else waiter(chunk);
  }

  read(): Promise<Uint8Array | undefined> {
    if (this.#chunks.length > 0) return Promise.resolve(this.#chunks.shift());
    return new Promise((resolve) => {
      this.#waiting = resolve;
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    // The startup packet is untagged, so a leading protocol version is how it is recognised.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length >= 8 && view.getInt32(4, false) === 196_608) {
      this.push(joined(frame('R', new ByteWriter().int32(0).finish()), ready()));
      return Promise.resolve();
    }
    const reader = new ByteReader(bytes, 'client');
    const tag = reader.tag();
    reader.int32();
    if (tag === 'Q') this.#answer(reader.cstring());
    if (tag === 'd') this.#recordStandby(reader.rest());
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.push(undefined);
  }

  #recordStandby(payload: Uint8Array): void {
    const reader = new ByteReader(payload, 'standby');
    if (reader.tag() !== 'r') return;
    const position = reader.int64();
    reader.int64();
    reader.int64();
    this.standby.push({ position, at: pgTimestampToEpochMs(reader.int64()) });
  }

  #answer(sql: string): void {
    this.queries.push(sql);
    if (sql.startsWith('START_REPLICATION')) {
      this.push(frame('W', new ByteWriter().uint8(0).int16(0).finish()));
      return;
    }
    if (sql === 'SHOW wal_level') {
      this.push(joined(dataRow([this.#script.walLevel ?? 'logical']), complete(), ready()));
      return;
    }
    if (sql.includes('pg_publication')) {
      const rows = this.#script.publicationExists === false ? [] : [dataRow(['1'])];
      this.push(joined(...rows, complete(), ready()));
      return;
    }
    if (sql.includes('pg_replication_slots')) {
      const plugin = this.#script.slotPlugin === undefined ? 'pgoutput' : this.#script.slotPlugin;
      const rows = plugin === null ? [] : [dataRow([plugin])];
      this.push(joined(...rows, complete(), ready()));
      return;
    }
    this.push(joined(dataRow(['ok']), complete(), ready()));
  }
}

/**
 * A walsender that parks on the `X` Terminate its connection writes on the way out, so a test can
 * hold a stream *mid-close* and race a `stop()` against it. Production's version of that race is a
 * SIGTERM landing on the same tick the walsender dies.
 */
export class ParkingWalsender extends FakeWalsender {
  #release: (() => void) | null = null;
  #arrive: (() => void) | null = null;
  /** Resolves once the goodbye is parked. `release()` lets it finish. */
  readonly parked: Promise<void> = new Promise((resolve) => {
    this.#arrive = resolve;
  });

  override async write(bytes: Uint8Array): Promise<void> {
    if (bytes[0] === 0x58) {
      this.#arrive?.();
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    await super.write(bytes);
  }

  release(): void {
    this.#release?.();
  }
}

export interface FeedOptions {
  readonly entities?: readonly string[];
  readonly statusIntervalMs?: number;
}

/** The feed every test in this package builds — one set of options, over whatever it dials. */
export const feedOver = (
  dial: () => Promise<PgStream>,
  options: FeedOptions = {},
): PgLogicalReplicationFeed =>
  new PgLogicalReplicationFeed({
    url: 'postgres://replicator:secret@db.test:5432/app',
    slot: 'ultimate_slot',
    publication: 'ultimate_pub',
    entities: options.entities ?? ['posts'],
    clock: frozenClock('2026-08-09T12:00:00.000Z'),
    stream: dial,
    ...(options.statusIntervalMs === undefined
      ? {}
      : { statusIntervalMs: options.statusIntervalMs }),
  });

export const POST_COLUMNS: readonly FixtureColumn[] = [
  { name: 'id', key: true },
  { name: 'title' },
  { name: 'org_id' },
  { name: 'price_minor' },
  { name: 'price_currency' },
];

export interface Started {
  readonly feed: PgLogicalReplicationFeed;
  readonly server: FakeWalsender;
  readonly events: ChangeEvent[];
  /** Resolves once `count` events have been delivered. */
  settled(count: number): Promise<void>;
}

export const start = async (
  options: FeedOptions & { script?: ServerScript; from?: string } = {},
): Promise<Started> => {
  const server = new FakeWalsender(options.script);
  const events: ChangeEvent[] = [];
  const feed = feedOver(() => Promise.resolve(server), options);
  await feed.start(
    options.from === undefined
      ? { onChange: (event) => void events.push(event) }
      : { from: options.from, onChange: (event) => void events.push(event) },
  );
  return {
    feed,
    server,
    events,
    // Nothing here is real I/O, so draining the microtask queue is a deterministic "let the pump
    // finish" — including the commit that follows the last row.
    settled: async (count) => {
      for (let tick = 0; tick < 200 && events.length < count; tick += 1) await Promise.resolve();
      for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    },
  };
};
