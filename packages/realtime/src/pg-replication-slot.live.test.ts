// A slot dropped under a resume position, on a real server (plan 101 R3): the feed resumes from a
// position whose slot is gone, creates a new one, and SAYS so — the scripted walsender
// (`pg-preflight-slot.test.ts`) cannot prove postgres answers the `wal_status` question as read.
//
// Skips unless a server with `wal_level = logical` is configured: `docker/test-services.env`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entity, entityForTable, text } from '@ultimat3/entity';
import type { ChangeEvent } from './changefeed';
import { postgresChangeFeed } from './changefeed';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const url = Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'];
const TABLE = 'x_live_slot_posts';
const SLOT = 'x_live_recreated_slot';
const PUBLICATION = 'x_live_slot_pub';

if (entityForTable(TABLE) === undefined) {
  entity(TABLE, { columns: { id: text().primaryKey(), orgId: text() } });
}

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

const logical = async (): Promise<boolean> => {
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

/** The preload freezes the clock, so waiting is counted in polls. */
const waitFor = async (done: () => boolean): Promise<void> => {
  // real-clock: a real postgres streams the WAL on its own time, not on any clock this test moves.
  for (let poll = 0; poll < 200 && !done(); poll += 1) await Bun.sleep(50);
};

describe.skipIf(!(await logical()))('live · a replication slot recreated under a resume', () => {
  let sql: PgConnection;
  const dropSlot = (): Promise<unknown> =>
    sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );

  beforeAll(async () => {
    sql = await admin();
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await dropSlot();
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.query(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, org_id text NOT NULL)`);
    await sql.query(`CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${TABLE}`);
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await dropSlot();
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.close();
  });

  test('the resume is said, and the new slot streams what comes after', async () => {
    const options = { url: url ?? '', slot: SLOT, publication: PUBLICATION, entities: [TABLE] };
    const first = postgresChangeFeed(options);
    const seen: ChangeEvent[] = [];
    await first.start({ onChange: (event) => void seen.push(event) });
    await sql.query(`INSERT INTO ${TABLE} VALUES ('p1', 'o1')`);
    await waitFor(() => seen.length >= 1);
    await first.stop();
    const from = first.lastLsn();
    if (from === null) return expect.unreachable('the first feed delivered nothing');

    await dropSlot();
    // Committed while no slot existed: never streamed, which is what the resync is for.
    await sql.query(`INSERT INTO ${TABLE} VALUES ('p2', 'o1')`);

    const second = postgresChangeFeed(options);
    const after: ChangeEvent[] = [];
    const resyncs: string[] = [];
    await second.start({
      from,
      onChange: (event) => void after.push(event),
      onResync: (reason) => void resyncs.push(reason),
    });
    expect(resyncs).toHaveLength(1);
    await sql.query(`INSERT INTO ${TABLE} VALUES ('p3', 'o1')`);
    await waitFor(() => after.length >= 1);
    await second.stop();
    expect(after.map((event) => event.after?.['id'])).toEqual(['p3']);
  });
});
