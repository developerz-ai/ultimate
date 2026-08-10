import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { ChangeEvent } from './changefeed';
import { PgLogicalReplicationFeed } from './changefeed';
import { ByteReader, ByteWriter, pgTimestampToEpochMs } from './pg-bytes';
import { changeLsn, commitPositionOf } from './pg-replication';
import type { PgStream } from './pg-wire';
import { frame } from './pg-wire';

// ---- pgoutput fixtures ------------------------------------------------------------------------

const POSTS_OID = 16_384;
const OTHER_OID = 16_385;
const TEXT = 25;

interface FixtureColumn {
  readonly name: string;
  readonly key?: boolean;
}

const relation = (oid: number, name: string, columns: readonly FixtureColumn[]): Uint8Array => {
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
      .int32(TEXT)
      .int32(-1);
  }
  return writer.finish();
};

const tuple = (writer: ByteWriter, values: readonly (string | null)[]): ByteWriter => {
  writer.int16(values.length);
  for (const value of values) {
    if (value === null) writer.uint8(0x6e);
    else writer.uint8(0x74).int32(value.length).utf8(value);
  }
  return writer;
};

const begin = (commitLsn: bigint, at: bigint, xid: number): Uint8Array =>
  new ByteWriter().uint8(0x42).int64(commitLsn).int64(at).int32(xid).finish();

const commit = (commitLsn: bigint, endLsn: bigint, at: bigint): Uint8Array =>
  new ByteWriter().uint8(0x43).uint8(0).int64(commitLsn).int64(endLsn).int64(at).finish();

const insert = (oid: number, values: readonly (string | null)[]): Uint8Array =>
  tuple(new ByteWriter().uint8(0x49).int32(oid).uint8(0x4e), values).finish();

const update = (
  oid: number,
  before: readonly (string | null)[] | null,
  after: readonly (string | null)[],
): Uint8Array => {
  const writer = new ByteWriter().uint8(0x55).int32(oid);
  if (before !== null) tuple(writer.uint8(0x4f), before);
  return tuple(writer.uint8(0x4e), after).finish();
};

const remove = (oid: number, before: readonly (string | null)[]): Uint8Array =>
  tuple(new ByteWriter().uint8(0x44).int32(oid).uint8(0x4f), before).finish();

/** `w` XLogData, wrapped as the `d` CopyData message the walsender sends it in. */
const xlog = (payload: Uint8Array, walEnd = 0n): Uint8Array =>
  frame(
    'd',
    new ByteWriter().uint8(0x77).int64(walEnd).int64(walEnd).int64(0n).raw(payload).finish(),
  );

const keepalive = (walEnd: bigint, replyRequested: number): Uint8Array =>
  frame('d', new ByteWriter().uint8(0x6b).int64(walEnd).int64(0n).uint8(replyRequested).finish());

// ---- a scripted walsender ---------------------------------------------------------------------

const dataRow = (values: readonly (string | null)[]): Uint8Array => {
  const writer = new ByteWriter().int16(values.length);
  for (const value of values) {
    if (value === null) writer.int32(-1);
    else writer.int32(value.length).utf8(value);
  }
  return frame('D', writer.finish());
};

const ready = (): Uint8Array => frame('Z', new Uint8Array([0x49]));
const complete = (): Uint8Array => frame('C', new ByteWriter().cstring('SELECT 1').finish());

const joined = (...parts: readonly Uint8Array[]): Uint8Array => {
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
class FakeWalsender implements PgStream {
  readonly queries: string[] = [];
  readonly standby: { position: bigint; at: number }[] = [];
  closed = false;
  readonly #chunks: Uint8Array[] = [];
  readonly #script: ServerScript;
  #waiting: ((chunk: Uint8Array | undefined) => void) | null = null;

  constructor(script: ServerScript = {}) {
    this.#script = script;
  }

  push(chunk: Uint8Array): void {
    const waiter = this.#waiting;
    this.#waiting = null;
    if (waiter === null) this.#chunks.push(chunk);
    else waiter(chunk);
  }

  read(): Promise<Uint8Array | undefined> {
    const next = this.#chunks.shift();
    if (next !== undefined) return Promise.resolve(next);
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
    this.push(undefined as unknown as Uint8Array);
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

const POST_COLUMNS: readonly FixtureColumn[] = [
  { name: 'id', key: true },
  { name: 'title' },
  { name: 'org_id' },
  { name: 'price_minor' },
  { name: 'price_currency' },
];

interface Started {
  readonly feed: PgLogicalReplicationFeed;
  readonly server: FakeWalsender;
  readonly events: ChangeEvent[];
  /** Resolves once `count` events have been delivered. */
  settled(count: number): Promise<void>;
}

const start = async (
  options: { script?: ServerScript; from?: string; entities?: readonly string[] } = {},
): Promise<Started> => {
  const server = new FakeWalsender(options.script);
  const events: ChangeEvent[] = [];
  const feed = new PgLogicalReplicationFeed({
    url: 'postgres://replicator:secret@db.test:5432/app',
    slot: 'ultimate_slot',
    publication: 'ultimate_pub',
    entities: options.entities ?? ['posts'],
    clock: frozenClock('2026-08-09T12:00:00.000Z'),
    stream: () => Promise.resolve(server),
  });
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

// ---- the ordering contract --------------------------------------------------------------------

describe('changeLsn', () => {
  test('sorts by commit position first and by position inside the transaction second', () => {
    const first = changeLsn(0x10n, 1);
    const second = changeLsn(0x10n, 2);
    const laterTx = changeLsn(0x11n, 1);
    expect(first < second).toBe(true);
    expect(second < laterTx).toBe(true);
    expect(first).toHaveLength(24);
  });

  test('a replayed transaction produces byte-identical lsns, which is what dedupes it', () => {
    expect(changeLsn(0x2b3c4dn, 7)).toBe(changeLsn(0x2b3c4dn, 7));
    expect(commitPositionOf(changeLsn(0x2b3c4dn, 7))).toBe(0x2b3c4dn);
  });
});

describe('PgLogicalReplicationFeed', () => {
  test('an empty entity list is refused before a socket is opened', () => {
    expect(
      () =>
        new PgLogicalReplicationFeed({
          url: 'postgres://x@y/z',
          slot: 's',
          publication: 'p',
          entities: [],
        }),
    ).toThrow(/empty entity list/);
  });

  test('preflights wal_level, the publication and the slot before it streams', async () => {
    const { server, feed } = await start();
    expect(server.queries[0]).toBe('SHOW wal_level');
    expect(server.queries[1]).toContain('pg_publication');
    expect(server.queries[2]).toContain('pg_replication_slots');
    expect(server.queries[3]).toStartWith('START_REPLICATION SLOT ultimate_slot LOGICAL 0/0');
    expect(server.queries[3]).toContain("publication_names 'ultimate_pub'");
    await feed.stop();
  });

  test('creates the slot when there is none, and never touches an existing one', async () => {
    const fresh = await start({ script: { slotPlugin: null } });
    expect(fresh.server.queries[3]).toBe(
      "SELECT pg_create_logical_replication_slot('ultimate_slot', 'pgoutput')",
    );
    await fresh.feed.stop();

    const existing = await start();
    expect(existing.server.queries.some((sql) => sql.includes('pg_create'))).toBe(false);
    await existing.feed.stop();
  });

  test('a non-logical wal_level names the exact statement that fixes it', async () => {
    const failure = await start({ script: { walLevel: 'replica' } }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((failure as { fix?: string }).fix).toContain("ALTER SYSTEM SET wal_level = 'logical'");
  });

  test('a missing publication and a foreign slot plugin each carry their own fix', async () => {
    const noPublication = await start({ script: { publicationExists: false } }).catch(
      (error: unknown) => error,
    );
    expect((noPublication as { fix?: string }).fix).toBe(
      'CREATE PUBLICATION ultimate_pub FOR ALL TABLES;',
    );

    const wrongPlugin = await start({ script: { slotPlugin: 'wal2json' } }).catch(
      (error: unknown) => error,
    );
    expect((wrongPlugin as { fix?: string }).fix).toContain('pg_drop_replication_slot');
  });

  test('an identifier outside [a-z_][a-z0-9_]* never reaches a replication command', async () => {
    const failure = await start({ entities: ["posts'; drop table users --"] }).catch(
      (error: unknown) => error,
    );
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
  });
});

describe('decoded changes', () => {
  test('an insert becomes a ChangeEvent with the entity row shape and the tenant hoisted', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x1000n, 0n, 42)));
    server.push(xlog(insert(POSTS_OID, ['p1', 'Hello', 'org-1', '1990', 'USD'])));
    server.push(xlog(commit(0x1000n, 0x1010n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      entity: 'posts',
      op: 'insert',
      before: null,
      after: {
        id: 'p1',
        title: 'Hello',
        orgId: 'org-1',
        price: { minor: '1990', currency: 'USD' },
      },
      lsn: changeLsn(0x1000n, 1),
      txid: '42',
      orgId: 'org-1',
      at: pgTimestampToEpochMs(0n),
    });
    expect(feed.lastLsn()).toBe(changeLsn(0x1000n, 1));
    await feed.stop();
  });

  test('every row of one transaction gets a strictly increasing lsn', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x2000n, 0n, 7)));
    for (let index = 1; index <= 5; index += 1) {
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', 'org-1', null, null])));
    }
    server.push(xlog(commit(0x2000n, 0x2100n, 0n)));
    await settled(5);

    const lsns = events.map((event) => event.lsn);
    expect(lsns).toHaveLength(5);
    expect([...lsns].sort()).toEqual(lsns);
    expect(new Set(lsns).size).toBe(5);
    await feed.stop();
  });

  test('a row for a table outside the entity list is skipped but still numbered', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'id', key: true }])));
    server.push(xlog(begin(0x3000n, 0n, 9)));
    server.push(xlog(insert(OTHER_OID, ['a1'])));
    server.push(xlog(insert(POSTS_OID, ['p9', 't', null, null, null])));
    server.push(xlog(commit(0x3000n, 0x3100n, 0n)));
    await settled(1);

    expect(events).toHaveLength(1);
    // Position 2, not 1: narrowing the entity list must not renumber the stream.
    expect(events[0]?.lsn).toBe(changeLsn(0x3000n, 2));
    expect(events[0]?.orgId).toBeNull();
    expect(feed.stats().skipped).toBe(1);
    await feed.stop();
  });

  test('update carries the old row and delete carries only what the identity replicated', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x4000n, 0n, 11)));
    server.push(
      xlog(
        update(POSTS_OID, ['p1', 'Old', 'org-1', null, null], ['p1', 'New', 'org-1', null, null]),
      ),
    );
    server.push(xlog(remove(POSTS_OID, ['p1', null, null, null, null])));
    server.push(xlog(commit(0x4000n, 0x4100n, 0n)));
    await settled(2);

    expect(events[0]?.op).toBe('update');
    expect(events[0]?.before?.['title']).toBe('Old');
    expect(events[0]?.after?.['title']).toBe('New');
    expect(events[1]?.op).toBe('delete');
    // A key-only identity nulls the non-key columns, and half a money value is not money — so the
    // two price columns stay as themselves rather than folding into an invalid `{minor, currency}`.
    expect(events[1]?.before).toEqual({
      id: 'p1',
      title: null,
      orgId: null,
      priceMinor: null,
      priceCurrency: null,
    });
    expect(events[1]?.after).toBeNull();
    await feed.stop();
  });

  test('an update with no old tuple has before: null rather than a fabricated row', async () => {
    const { server, events, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x5000n, 0n, 12)));
    server.push(xlog(update(POSTS_OID, null, ['p1', 'New', null, null, null])));
    server.push(xlog(commit(0x5000n, 0x5100n, 0n)));
    await settled(1);

    expect(events[0]?.before).toBeNull();
    await feed.stop();
  });

  test('a resume drops the rows the cursor already covers and delivers the rest', async () => {
    const { server, events, settled, feed } = await start({ from: changeLsn(0x6000n, 2) });
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x6000n, 0n, 13)));
    for (let index = 1; index <= 4; index += 1) {
      server.push(xlog(insert(POSTS_OID, [`p${index}`, 't', null, null, null])));
    }
    server.push(xlog(commit(0x6000n, 0x6100n, 0n)));
    await settled(2);

    expect(events.map((event) => event.after?.['id'])).toEqual(['p3', 'p4']);
    expect(feed.stats().replayed).toBe(2);
    expect(server.queries[3]).toContain('LOGICAL 0/6000');
    await feed.stop();
  });

  test('a replicated table with no text id is a loud configuration error', async () => {
    const { server, feed } = await start({ entities: ['audit_log'] });
    server.push(xlog(relation(OTHER_OID, 'audit_log', [{ name: 'seq', key: true }])));
    server.push(xlog(begin(0x7000n, 0n, 14)));
    server.push(xlog(insert(OTHER_OID, ['1'])));
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
    // The pump reports and ends rather than delivering a row the pipeline cannot address.
    expect(feed.stats().delivered).toBe(0);
    await feed.stop();
  });
});

describe('slot confirmation', () => {
  test('a keepalive asking for a reply is answered with the confirmed position', async () => {
    const { server, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0x8000n, 0n, 15)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null])));
    server.push(xlog(commit(0x8000n, 0x8100n, 0n)));
    await settled(1);
    server.push(keepalive(0x9000n, 1));
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();

    const last = server.standby.at(-1);
    expect(last?.position).toBe(0x9000n);
    expect(last?.at).toBe(Date.UTC(2026, 7, 9, 12, 0, 0));
    await feed.stop();
  });

  test('stop confirms what was delivered before it says goodbye', async () => {
    const { server, settled, feed } = await start();
    server.push(xlog(relation(POSTS_OID, 'posts', POST_COLUMNS)));
    server.push(xlog(begin(0xa000n, 0n, 16)));
    server.push(xlog(insert(POSTS_OID, ['p1', 't', null, null, null])));
    server.push(xlog(commit(0xa000n, 0xa100n, 0n)));
    await settled(1);
    await feed.stop();

    expect(server.standby.at(-1)?.position).toBe(0xa100n);
    expect(server.closed).toBe(true);
  });
});
