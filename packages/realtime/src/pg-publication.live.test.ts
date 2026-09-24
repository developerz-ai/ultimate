// The replicator ensures its publication against a REAL server, over the replication session it
// boots on: created FOR the entity tables, extended by the one it lacks, never shrunk — and a role
// that owns none of the tables is refused with the statement to run. The scripted half is
// `pg-publication.test.ts`; this is the proof `replication=database` accepts the DDL at all.
//
// Skips unless a server with `wal_level = logical` is configured. Locally:
//
//   docker run -d --name x-repl -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -p 5433:5432 postgres:17-alpine -c wal_level=logical
//   TEST_REPLICATION_URL=postgres://ultimate:ultimate@localhost:5433/postgres \
//     bun test packages/realtime/src/pg-publication.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PgLogicalReplicationFeed } from './changefeed';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const url =
  Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];

const PUBLICATION = 'x_pub_live';
const POSTS = 'x_pub_live_posts';
const USERS = 'x_pub_live_users';
const OPERATOR_TABLE = 'x_pub_live_audit';
const SLOTS = ['x_pub_live_created', 'x_pub_live_extended', 'x_pub_live_refused'] as const;
const OUTSIDER = 'x_pub_live_outsider';

const connect = async (target = url ?? ''): Promise<PgConnection> => {
  const parsed = parsePgUrl(target);
  return PgConnection.open({
    stream: await bunPgStream(parsed),
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    applicationName: 'ultimate-live-test',
  });
};

/** Probed with a bound, so an unreachable host reads as "skip" rather than a TCP timeout. */
const logicalWal = async (): Promise<boolean> => {
  const probe = (async () => {
    try {
      const connection = await connect();
      const [row] = await connection.query('SHOW wal_level');
      await connection.close();
      return row?.[0] === 'logical';
    } catch {
      return false;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), 2_000);
    timer.unref?.();
  });
  const answer = await Promise.race([probe, expiry]);
  clearTimeout(timer);
  return answer;
};

const ready = url !== undefined && url !== '' && (await logicalWal());

const feedFor = (
  slot: string,
  entities: readonly string[],
  target = url ?? '',
): PgLogicalReplicationFeed =>
  new PgLogicalReplicationFeed({ url: target, slot, publication: PUBLICATION, entities });

describe.skipIf(!ready)('live · the replicator ensures its publication', () => {
  let sql: PgConnection;

  const members = async (): Promise<string[]> =>
    (
      await sql.query(
        `SELECT tablename FROM pg_publication_tables WHERE pubname = '${PUBLICATION}' ` +
          'ORDER BY tablename',
      )
    ).map((row) => row[0] ?? '');

  const reset = async (): Promise<void> => {
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      'SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots ' +
        `WHERE slot_name IN (${SLOTS.map((slot) => `'${slot}'`).join(', ')})`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${POSTS}, ${USERS}, ${OPERATOR_TABLE}`);
    await sql.query(`DROP ROLE IF EXISTS ${OUTSIDER}`);
  };

  beforeAll(async () => {
    sql = await connect();
    await reset();
    for (const table of [POSTS, USERS, OPERATOR_TABLE]) {
      await sql.query(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
      await sql.query(`ALTER TABLE ${table} REPLICA IDENTITY FULL`);
    }
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await reset();
    await sql.close();
  });

  test('a missing publication is created FOR the entity tables at boot', async () => {
    const feed = feedFor(SLOTS[0], [POSTS, USERS]);
    await feed.start({ onChange: () => undefined });
    await feed.stop();
    expect(await members()).toEqual([POSTS, USERS]);
    const [all] = await sql.query(
      `SELECT puballtables FROM pg_publication WHERE pubname = '${PUBLICATION}'`,
    );
    expect(all?.[0]).toBe('f');
  });

  test('a publication lacking an entity table gains it, and keeps the operator’s own', async () => {
    await sql.query(`DROP PUBLICATION ${PUBLICATION}`);
    await sql.query(`CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${POSTS}, ${OPERATOR_TABLE}`);
    const feed = feedFor(SLOTS[1], [POSTS, USERS]);
    await feed.start({ onChange: () => undefined });
    await feed.stop();
    expect(await members()).toEqual([OPERATOR_TABLE, POSTS, USERS]);
  });

  test('a role owning none of the tables is refused with the statement to run', async () => {
    await sql.query(`DROP PUBLICATION ${PUBLICATION}`);
    await sql.query(`CREATE ROLE ${OUTSIDER} LOGIN REPLICATION PASSWORD 'outsider'`);
    const target = new URL(url ?? '');
    target.username = OUTSIDER;
    target.password = 'outsider';
    const feed = feedFor(SLOTS[2], [POSTS], target.toString());
    const failure = await feed.start({ onChange: () => undefined }).then(
      () => expect.unreachable('a role owning nothing created the publication'),
      (error: unknown) => error,
    );
    await feed.stop();
    expect((failure as { code?: string }).code).toBe('X_REPLICATION_FAILED');
    expect((failure as { fix?: string }).fix).toStartWith(
      `CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${POSTS};`,
    );
    expect(await members()).toEqual([]);
  });
});
