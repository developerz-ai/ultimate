// A replicator restart against a real Postgres slot, read by a sync node's gap detector (and the
// handover the node reads beside it): a stop and a start of one replicator, and a NEW process after
// a clean stop — a deploy — both chain, so no subscriber is re-snapshotted; a crash costs one.
// Skips unless TEST_REPLICATION_URL names a server with `wal_level = logical`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entity, entityForTable, text } from '@ultimat3/entity';
import { memoryAdvisoryLock } from './advisory-lock';
import { postgresChangeFeed } from './changefeed';
import { InProcessTransport } from './fanout';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { CHANGE_SUBJECT_PREFIX, changeFeedReplicator, type Replicator } from './replicator';
import { parseEnvelope, SeqGapDetector } from './replicator-envelope';
import { parseHandover } from './replicator-handover';

const url = Bun.env['TEST_REPLICATION_URL'] ?? '';
const TABLE = 'x_live_chain_posts';
const SLOT = 'x_live_chain_slot';
const PUBLICATION = 'x_live_chain_pub';

if (entityForTable(TABLE) === undefined) {
  entity(TABLE, { columns: { id: text().primaryKey(), orgId: text() } });
}

/** The preload freezes the clock, so waiting is counted in polls rather than in elapsed time. */
const waitFor = async (done: () => boolean, polls = 400): Promise<void> => {
  // real-clock: a real postgres streams the WAL on its own time, not on any clock this test moves.
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(50);
};

const admin = async (): Promise<PgConnection> => {
  const target = parsePgUrl(url);
  return PgConnection.open({
    stream: await bunPgStream(target),
    user: target.user,
    password: target.password,
    database: target.database,
    applicationName: 'ultimate-live-chain',
  });
};

const logicalWal = async (): Promise<boolean> => {
  if (url === '') return false;
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

describe.skipIf(!ready)('live · a replicator restart and the sync node that reads it', () => {
  let sql: PgConnection;
  const transport = new InProcessTransport();
  const gaps = new SeqGapDetector();
  let changes = 0;
  let invalidations = 0;
  let next = 0;

  const feed = () =>
    postgresChangeFeed({
      url,
      slot: SLOT,
      publication: PUBLICATION,
      entities: [TABLE],
      statusIntervalMs: 100,
    });
  // One lock per process: a new process takes a grant the last one let go of, or never held.
  const lock = () => memoryAdvisoryLock(`x:replicator:live-chain-${crypto.randomUUID()}`);
  const confirmed = async (): Promise<string> => {
    const [row] = await sql.query(
      `SELECT confirmed_flush_lsn FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    return row?.[0] ?? '';
  };
  const write = async (): Promise<void> => {
    next += 1;
    const seen = changes;
    await sql.query(`INSERT INTO ${TABLE} (id, org_id) VALUES ('c${next}', 'org-1')`);
    await waitFor(() => changes > seen);
  };

  beforeAll(async () => {
    sql = await admin();
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.query(`CREATE TABLE ${TABLE} (id text PRIMARY KEY, org_id text NOT NULL)`);
    await sql.query(`CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${TABLE}`);
    await transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      const handover = parseHandover(payload);
      if (handover !== null) {
        if (gaps.handOver(handover)) invalidations += 1;
        return;
      }
      const envelope = parseEnvelope(payload);
      if (envelope === null) return;
      changes += 1;
      if (gaps.observe(envelope)) invalidations += 1;
    });
  });

  afterAll(async () => {
    if (sql === undefined) return;
    await transport.close();
    await sql.query(`DROP PUBLICATION IF EXISTS ${PUBLICATION}`);
    await sql.query(
      `SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = '${SLOT}'`,
    );
    await sql.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await sql.close();
  });

  test('stop() then start(): the new run chains on, no window is invalidated', async () => {
    const replicator: Replicator = changeFeedReplicator({ feed: feed(), transport, lock: lock() });
    expect(await replicator.start()).toBe(true);
    await write();
    await write();
    await replicator.stop();
    expect(await replicator.start()).toBe(true);
    await write();
    await replicator.stop();
    expect(changes).toBe(3);
    expect(invalidations).toBe(0);
  }, 60_000);

  test('a clean stop, then a NEW process — a deploy: no window is invalidated', async () => {
    const before = invalidations;
    const old = changeFeedReplicator({ feed: feed(), transport, lock: lock() });
    expect(await old.start()).toBe(true);
    await write();
    await old.stop();
    const next = changeFeedReplicator({ feed: feed(), transport, lock: lock() });
    expect(await next.start()).toBe(true);
    await write();
    await write();
    await next.stop();
    expect(invalidations - before).toBe(0);
  }, 60_000);

  test('a crash after the slot confirmed past what the node read: exactly one', async () => {
    const before = invalidations;
    const doomed = feed();
    const old = changeFeedReplicator({ feed: doomed, transport, lock: lock() });
    expect(await old.start()).toBe(true);
    const was = await confirmed();
    await write();
    // real-clock: the slot is confirmed on the walsender's time, by a status update it reads.
    for (let poll = 0; poll < 400 && (await confirmed()) === was; poll += 1) await Bun.sleep(50);
    // Killed: the socket drops, nothing is confirmed or said on the way out.
    doomed.abandon();
    const next = changeFeedReplicator({ feed: feed(), transport, lock: lock() });
    expect(await next.start()).toBe(true);
    await write();
    await write();
    await next.stop();
    expect(invalidations - before).toBe(1);
  }, 60_000);
});
