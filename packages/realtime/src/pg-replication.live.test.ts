// The only proof that the WAL decoder is right: a real Postgres, a real publication, a real slot.
// Everything else in this package drives a scripted walsender — which cannot catch a wrong type
// oid, a misread tuple flag or a SCRAM exchange the server disagrees with.
//
// Skips unless a server with `wal_level = logical` is configured. Locally:
//
//   docker run -d --name x-repl -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -p 5433:5432 postgres:17-alpine -c wal_level=logical
//   TEST_REPLICATION_URL=postgres://ultimate:ultimate@localhost:5433/postgres \
//     bun test packages/realtime/src/pg-replication.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ChangeEvent } from './changefeed';
import { PgLogicalReplicationFeed } from './changefeed';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const url =
  Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];

const TABLE = 'x_live_posts';
const SLOT = 'x_live_slot';
const PUBLICATION = 'x_live_pub';

/** The preload freezes the clock, so waiting is counted in polls rather than in elapsed time. */
const waitFor = async (done: () => boolean, polls = 400): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(50);
};

const admin = async (): Promise<PgConnection> => {
  const target = parsePgUrl(url ?? '');
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: target.user,
    password: target.password,
    database: target.database,
    applicationName: 'ultimate-live-test',
  });
};

/** `wal_level` is a restart-only GUC, so a server without it can only be skipped, never fixed. */
const logicalWal = async (): Promise<boolean> => {
  if (url === undefined || url === '') return false;
  try {
    const connection = await admin();
    const [row] = await connection.query('SHOW wal_level');
    await connection.close();
    return row?.[0] === 'logical';
  } catch {
    return false;
  }
};

const ready = await logicalWal();

describe.skipIf(!ready)('live · postgres logical replication', () => {
  let sql: PgConnection;

  beforeAll(async () => {
    sql = await admin();
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.query(
      `CREATE TABLE ${TABLE} (
         id text PRIMARY KEY,
         title text,
         org_id text,
         view_count integer,
         published boolean,
         price_minor bigint,
         price_currency text,
         meta jsonb
       )`,
    );
    // The matcher decides whether a row *left* a result set, which needs the old values.
    await sql.query(`ALTER TABLE ${TABLE} REPLICA IDENTITY FULL`);
    await sql.query(`CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${TABLE}`);
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.close();
  });

  test('decodes a real WAL stream into ordered ChangeEvents', async () => {
    const events: ChangeEvent[] = [];
    const feed = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: SLOT,
      publication: PUBLICATION,
      entities: [TABLE],
      statusIntervalMs: 250,
    });
    // Creating the slot is part of `start`; it must exist before the writes, or the WAL that
    // carries them is already behind the slot's starting position.
    await feed.start({ onChange: (event) => void events.push(event) });

    await sql.query(`
      BEGIN;
      INSERT INTO ${TABLE} VALUES ('p1', 'First', 'org-1', 3, true, 1990, 'USD', '{"tags":["a"]}');
      INSERT INTO ${TABLE} VALUES ('p2', 'Second', 'org-2', 0, false, NULL, NULL, NULL);
      COMMIT;
    `);
    await sql.query(`UPDATE ${TABLE} SET title = 'Renamed', view_count = 4 WHERE id = 'p1'`);
    await sql.query(`DELETE FROM ${TABLE} WHERE id = 'p2'`);

    await waitFor(() => events.length >= 4);
    if (events.length < 4) await feed.stop();

    expect(events).toHaveLength(4);
    const [first, second, updated, deleted] = events;

    expect(first?.entity).toBe(TABLE);
    expect(first?.op).toBe('insert');
    expect(first?.orgId).toBe('org-1');
    expect(first?.after).toEqual({
      id: 'p1',
      title: 'First',
      orgId: 'org-1',
      viewCount: 3,
      published: true,
      price: { minor: 1990, currency: 'USD' },
      meta: { tags: ['a'] },
    });
    expect(first?.at).toBeGreaterThan(Date.UTC(2020, 0, 1));

    expect(second?.after?.['id']).toBe('p2');
    expect(second?.after?.['published']).toBe(false);
    expect(second?.orgId).toBe('org-2');
    // One transaction, two rows: the pair must not collapse onto one lsn.
    expect(first?.txid).toBe(second?.txid ?? '');
    expect(second?.lsn > (first?.lsn ?? '')).toBe(true);

    expect(updated?.op).toBe('update');
    expect(updated?.before?.['title']).toBe('First');
    expect(updated?.after?.['title']).toBe('Renamed');
    expect(updated?.after?.['viewCount']).toBe(4);
    expect(updated?.lsn > (second?.lsn ?? '')).toBe(true);

    expect(deleted?.op).toBe('delete');
    expect(deleted?.before?.['id']).toBe('p2');
    expect(deleted?.after).toBeNull();

    const lsns = events.map((event) => event.lsn);
    expect([...lsns].sort()).toEqual(lsns);
    expect(feed.lastLsn()).toBe(lsns.at(-1) ?? null);

    await feed.stop();

    // The slot moved, which is what stops the WAL from growing without bound.
    const [slot] = await sql.query(
      `SELECT confirmed_flush_lsn <> '0/0', active FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    expect(slot?.[0]).toBe('t');
    expect(slot?.[1]).toBe('f');
  }, 60_000);

  test('a resume delivers each change exactly once across a restart', async () => {
    const first: ChangeEvent[] = [];
    const one = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: SLOT,
      publication: PUBLICATION,
      entities: [TABLE],
      statusIntervalMs: 250,
    });
    await one.start({ onChange: (event) => void first.push(event) });
    await sql.query(`INSERT INTO ${TABLE} (id, title) VALUES ('r1', 'a'), ('r2', 'b')`);
    await waitFor(() => first.length >= 2);
    const cursor = one.lastLsn();
    await one.stop();
    expect(first).toHaveLength(2);

    await sql.query(`INSERT INTO ${TABLE} (id, title) VALUES ('r3', 'c')`);

    const second: ChangeEvent[] = [];
    const two = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: SLOT,
      publication: PUBLICATION,
      entities: [TABLE],
      statusIntervalMs: 250,
    });
    await two.start({ from: cursor ?? '', onChange: (event) => void second.push(event) });
    await waitFor(() => second.length >= 1);
    await two.stop();

    // r1/r2 were already delivered; a replay of them must be dropped, not sent twice.
    expect(second.map((event) => event.after?.['id'])).toEqual(['r3']);
  }, 60_000);
});
