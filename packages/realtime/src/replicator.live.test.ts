// A replicator restart against a real Postgres slot, read by a sync node's gap detector (and the
// handover the node reads beside it): a stop and a start of one replicator, and a NEW process after
// a clean stop — a deploy — both chain, so no subscriber is re-snapshotted; a crash costs one, and
// so does a run that comes back after another process confirmed the slot past it.
// Skips unless TEST_REPLICATION_URL names a server with `wal_level = logical`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { entity, entityForTable, text } from '@ultimat3/entity';
import { type AdvisoryLock, memoryAdvisoryLock } from './advisory-lock';
import { postgresChangeFeed } from './changefeed';
import { InProcessTransport, type Transport } from './fanout';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';
import { CHANGE_SUBJECT_PREFIX, changeFeedReplicator, type Replicator } from './replicator';
import { parseEnvelope, SeqGapDetector } from './replicator-envelope';
import { parseHandover } from './replicator-handover';
import type { Scheduler } from './thundering-herd';

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

/** A lock whose session the test kills: `lose()` lets go and says so, as a dead session would. */
const losableLock = (key: string): AdvisoryLock & { lose(reason: string): void } => {
  const inner = memoryAdvisoryLock(key);
  const listeners = new Set<(reason: string) => void>();
  return {
    key,
    tryAcquire: () => inner.tryAcquire(),
    release: () => inner.release(),
    abandon: () => inner.abandon(),
    onLost: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    lose: (reason) => {
      inner.abandon();
      for (const listener of [...listeners]) listener(reason);
    },
  };
};

/** The bus as one process sees it, losing every payload `drops` names — published, never heard. */
const lossy = (bus: Transport, drops: (payload: string) => boolean): Transport => ({
  name: bus.name,
  shared: bus.shared,
  publish: (subject, payload) =>
    drops(payload) ? Promise.resolve() : bus.publish(subject, payload),
  subscribe: (subject, handler) => bus.subscribe(subject, handler),
  onReconnect: (listener) => bus.onReconnect(listener),
  close: () => bus.close(),
});

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

  test('a run that lost its lock, after its successor confirmed past what the node read: one', async () => {
    const bus = new InProcessTransport();
    const node = new SeqGapDetector();
    const seen: string[] = [];
    let missed = 0;
    await bus.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
      const handover = parseHandover(payload);
      if (handover !== null) {
        if (node.handOver(handover)) missed += 1;
        return;
      }
      const envelope = parseEnvelope(payload);
      if (envelope === null) return;
      seen.push(String(envelope.change.after?.['id']));
      if (node.observe(envelope)) missed += 1;
    });
    const insert = (id: string) =>
      sql.query(`INSERT INTO ${TABLE} (id, org_id) VALUES ('${id}', 'org-1')`);
    /** Until the slot is confirmed through everything written so far — a commit, then its keepalive. */
    const confirmedThroughNow = async (): Promise<void> => {
      const [row] = await sql.query('SELECT pg_current_wal_lsn()::text');
      const target = row?.[0] ?? '';
      const through = `SELECT confirmed_flush_lsn >= '${target}'::pg_lsn FROM pg_replication_slots WHERE slot_name = '${SLOT}'`;
      for (let poll = 0; poll < 400; poll += 1) {
        const [answer] = await sql.query(through);
        if (answer?.[0] === 't') return;
        // real-clock: the slot is confirmed on the walsender's time, by a status update it reads.
        await Bun.sleep(50);
      }
    };
    const key = `x:replicator:live-cut-${crypto.randomUUID()}`;
    // P1's takeover loop waits on this: the test says when it asks again.
    const retries: (() => void)[] = [];
    const held: Scheduler = (fn) => {
      retries.push(fn);
      return () => undefined;
    };
    const p1Lock = losableLock(key);
    const p1 = changeFeedReplicator({ feed: feed(), transport: bus, lock: p1Lock, schedule: held });
    expect(await p1.start()).toBe(true);
    await insert('cut-a');
    await waitFor(() => seen.includes('cut-a'));
    await confirmedThroughNow();
    p1Lock.lose('the session was terminated');
    expect(p1.running).toBe(false);
    // P2 takes over; the node never hears `cut-c`, and P2 dies with nothing said.
    const p2Feed = feed();
    const p2Lock = memoryAdvisoryLock(key);
    const p2Bus = lossy(bus, (payload) => payload.includes('"cut-c"'));
    const p2 = changeFeedReplicator({
      feed: p2Feed,
      transport: p2Bus,
      lock: p2Lock,
      schedule: held,
    });
    expect(await p2.start()).toBe(true);
    await insert('cut-b');
    await waitFor(() => seen.includes('cut-b'));
    await insert('cut-c');
    await waitFor(() => p2.stats().published === 2);
    await confirmedThroughNow();
    p2Feed.abandon();
    p2Lock.abandon();
    // A takeover with no handover is a crash to the node: that one is paid already.
    const before = missed;
    // P1 asks again, resuming from ITS last lsn — below where the slot now stands.
    for (const fn of retries.splice(0)) fn();
    await waitFor(() => p1.running);
    await insert('cut-d');
    await waitFor(() => seen.includes('cut-d'));
    await p1.stop();
    expect(seen).not.toContain('cut-c');
    expect(missed - before).toBe(1);
    await bus.close();
  }, 60_000);
});
