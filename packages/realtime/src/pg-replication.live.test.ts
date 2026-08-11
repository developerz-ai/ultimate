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
import { selectChangeFeed } from './changefeed-env';
import { InProcessTransport } from './fanout';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { CHANGE_SUBJECT_PREFIX, createReplicator } from './replicator';

const url =
  Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];

const TABLE = 'x_live_posts';
// One slot per case. A slot carries the previous case's position, and a feed started with no
// cursor resumes from it — so the decode case's last transaction, delivered but not yet confirmed
// when its feed stopped, is legitimately re-sent to whoever opens that slot next. Sharing one slot
// made the resume case assert "exactly two" against a stream that owes it three.
const SLOT = 'x_live_slot';
const RESUME_SLOT = 'x_live_resume_slot';
const WIRED_SLOT = 'x_live_wired_slot';
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
  try {
    const connection = await admin();
    const [row] = await connection.query('SHOW wal_level');
    await connection.close();
    return row?.[0] === 'logical';
  } catch {
    return false;
  }
};

/**
 * The probe runs at module load, before the suite is collected, so a stale `DATABASE_URL` pointing
 * at an unreachable host would otherwise cost a full TCP timeout on every `bun test` run. Unset is
 * free — no connection at all — and unreachable costs this bound, then reads as "skip".
 */
const PROBE_TIMEOUT_MS = 2_000;

const bounded = async (probe: Promise<boolean>): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  const answer = await Promise.race([probe, expiry]);
  clearTimeout(timer);
  return answer;
};

const ready = url !== undefined && url !== '' && (await bounded(logicalWal()));

describe.skipIf(!ready)('live · postgres logical replication', () => {
  let sql: PgConnection;

  /** Both slots, dropped by one statement so neither case inherits the other's position. */
  const dropSlots = async (): Promise<void> => {
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots ` +
        `WHERE slot_name IN ('${SLOT}', '${RESUME_SLOT}', '${WIRED_SLOT}')`,
    );
  };

  beforeAll(async () => {
    sql = await admin();
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await dropSlots();
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
    await dropSlots();
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
    expect((second?.lsn ?? '') > (first?.lsn ?? '')).toBe(true);

    expect(updated?.op).toBe('update');
    expect(updated?.before?.['title']).toBe('First');
    expect(updated?.after?.['title']).toBe('Renamed');
    expect(updated?.after?.['viewCount']).toBe(4);
    expect((updated?.lsn ?? '') > (second?.lsn ?? '')).toBe(true);

    expect(deleted?.op).toBe('delete');
    expect(deleted?.before?.['id']).toBe('p2');
    expect(deleted?.after).toBeNull();

    const lsns = events.map((event) => event.lsn);
    expect([...lsns].sort()).toEqual(lsns);
    expect(feed.lastLsn()).toBe(lsns.at(-1) ?? null);

    await feed.stop();

    // `active` flips when the *server's* walsender exits, which it does after this process closed
    // the socket — so the slot is released eventually, never synchronously with `stop()`. Polled
    // rather than read once: a single read turns a loaded runner into a failing assertion.
    const slotRow = async (): Promise<readonly (string | null)[] | undefined> => {
      const [row] = await sql.query(
        `SELECT confirmed_flush_lsn <> '0/0', active FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
      );
      return row;
    };
    let slot = await slotRow();
    for (let poll = 0; poll < 200 && slot?.[1] !== 'f'; poll += 1) {
      await Bun.sleep(50);
      slot = await slotRow();
    }

    // The slot moved, which is what stops the WAL from growing without bound.
    expect(slot?.[0]).toBe('t');
    // And it was released: a slot still held is one the next replicator cannot claim.
    expect(slot?.[1]).toBe('f');
  }, 60_000);

  test('a resume delivers each change exactly once across a restart', async () => {
    const first: ChangeEvent[] = [];
    // Its own slot, created by this `start`: what a resume drops must be what *this* feed already
    // delivered, not whatever the previous case left unconfirmed on a shared one.
    const one = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: RESUME_SLOT,
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
      slot: RESUME_SLOT,
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

  /**
   * The reachability proof. Every other case builds the feed by hand, which is exactly how it
   * shipped with no production caller: nothing in the framework ever constructed one. This case
   * starts from environment variables — the only input a container gets — and asserts a row
   * written to Postgres arrives on the bus.
   */
  test('environment variables alone reach the bus: env → feed → replicator → transport', async () => {
    const selection = selectChangeFeed(
      {
        DATABASE_URL: url,
        REPLICATION_SLOT: WIRED_SLOT,
        REPLICATION_PUBLICATION: PUBLICATION,
      },
      { entities: [TABLE] },
    );
    expect(selection.mode).toBe('external');
    expect(selection.detail).toBe('DATABASE_URL');

    const transport = new InProcessTransport();
    const published: { subject: string; payload: string }[] = [];
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload, subject) => {
      published.push({ subject, payload });
    });

    const replicator = createReplicator({
      feed: selection.feed,
      transport,
      lock: selection.lock,
    });
    expect(await replicator.start()).toBe(true);
    try {
      await sql.query(`INSERT INTO ${TABLE} (id, title, org_id) VALUES ('w1', 'wired', 'org-1')`);
      await waitFor(() => published.length >= 1);
    } finally {
      await replicator.stop();
      await transport.close();
    }

    expect(replicator.stats().published).toBeGreaterThanOrEqual(1);
    const change = JSON.parse(published[0]?.payload ?? '{}') as ChangeEvent;
    // The tenant is in the subject, so a fanout filters without parsing the row at all.
    expect(published[0]?.subject).toBe(`${CHANGE_SUBJECT_PREFIX}.${TABLE}.org-1`);
    expect(change.entity).toBe(TABLE);
    expect(change.op).toBe('insert');
    expect(change.after?.['id']).toBe('w1');
    expect(change.orgId).toBe('org-1');
  }, 60_000);
});
