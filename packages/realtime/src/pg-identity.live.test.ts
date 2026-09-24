// Which replicated tables the replicator warns about, asked of a REAL catalog. A table with a
// primary key replicates correctly under the default identity — the shared window holds the whole
// row — so warning about it was noise every boot. A table with NO identity (no primary key, or
// REPLICA IDENTITY NOTHING) is the real problem: once published, its UPDATE and DELETE fail.
//
// Skips unless a server with `wal_level = logical` is configured — see
// `pg-replication.live.test.ts` for the one-line container.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { logger } from '@ultimat3/core';
import { PgLogicalReplicationFeed } from './changefeed';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const url = Bun.env['TEST_REPLICATION_URL'];

const KEYED = 'x_id_live_keyed';
const KEYLESS = 'x_id_live_keyless';
const NOTHING = 'x_id_live_nothing';
const FULL = 'x_id_live_full';
const DROPPED_INDEX = 'x_id_live_dropped_index';
const TABLES = [KEYED, KEYLESS, NOTHING, FULL, DROPPED_INDEX];
const SLOT = 'x_id_live_slot';
const PUBLICATION = 'x_id_live_pub';

const connect = async (): Promise<PgConnection> => {
  const target = parsePgUrl(url ?? '');
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: target.user,
    password: target.password,
    database: target.database,
    applicationName: 'ultimate-identity-live-test',
  });
};

/** Set on purpose, so a broken connection fails the suite rather than skipping it. */
const ready = url !== undefined && url !== '';

describe.skipIf(!ready)('live · the replica identity warning', () => {
  let sql: PgConnection;

  const reset = async (): Promise<void> => {
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`);
  };

  beforeAll(async () => {
    sql = await connect();
    await reset();
    await sql.query(`CREATE TABLE ${KEYED} (id text PRIMARY KEY)`);
    await sql.query(`CREATE TABLE ${KEYLESS} (id text)`);
    await sql.query(`CREATE TABLE ${NOTHING} (id text PRIMARY KEY)`);
    await sql.query(`ALTER TABLE ${NOTHING} REPLICA IDENTITY NOTHING`);
    await sql.query(`CREATE TABLE ${FULL} (id text)`);
    await sql.query(`ALTER TABLE ${FULL} REPLICA IDENTITY FULL`);
    // USING INDEX, then the index dropped: `relreplident` stays 'i' and the table has no identity.
    await sql.query(`CREATE TABLE ${DROPPED_INDEX} (id text NOT NULL)`);
    await sql.query(`CREATE UNIQUE INDEX ${DROPPED_INDEX}_id ON ${DROPPED_INDEX} (id)`);
    await sql.query(
      `ALTER TABLE ${DROPPED_INDEX} REPLICA IDENTITY USING INDEX ${DROPPED_INDEX}_id`,
    );
    await sql.query(`DROP INDEX ${DROPPED_INDEX}_id`);
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await reset();
    await sql.close();
  });

  test('names only the tables with no identity: no primary key, NOTHING, or a dropped identity index', async () => {
    const warn = spyOn(logger, 'warn');
    const feed = new PgLogicalReplicationFeed({
      url: url ?? '',
      slot: SLOT,
      publication: PUBLICATION,
      entities: TABLES,
    });
    try {
      await feed.start({ onChange: () => undefined });
    } finally {
      await feed.stop();
    }
    const line = warn.mock.calls.find((call) => call[0] === 'X_LIVE_REPLICA_IDENTITY');
    warn.mockRestore();
    expect(line?.[1]).toMatchObject({ tables: [DROPPED_INDEX, KEYLESS, NOTHING] });
  });
});
