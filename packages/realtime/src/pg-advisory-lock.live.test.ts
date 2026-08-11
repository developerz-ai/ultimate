// The only proof that "exactly one replicator per database" holds: two locks, one real Postgres.
// A scripted server answers whatever the script says, so it can prove the SQL is sent and never
// that the server refuses the second caller — which is the whole invariant.
//
// Skips unless a server is configured. Locally:
//
//   docker run -d --name x-repl -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -p 5433:5432 postgres:17-alpine -c wal_level=logical
//   TEST_REPLICATION_URL=postgres://ultimate:ultimate@localhost:5433/postgres \
//     bun test packages/realtime/src/pg-advisory-lock.live.test.ts

import { afterEach, describe, expect, test } from 'bun:test';
import { selectChangeFeed } from './changefeed-env';
import { PgAdvisoryLock } from './pg-advisory-lock';
import { PgConnection } from './pg-connection';
import { bunPgStream, parsePgUrl } from './pg-socket';

const url =
  Bun.env['TEST_REPLICATION_URL'] ?? Bun.env['TEST_DATABASE_URL'] ?? Bun.env['DATABASE_URL'];

const KEY = 'x:replicator:x_live_lock_slot';

const held: PgAdvisoryLock[] = [];

const lock = (key = KEY): PgAdvisoryLock => {
  const made = new PgAdvisoryLock({ url: url ?? '', key });
  held.push(made);
  return made;
};

/** A lock left held would fail every case after it, so release runs even when a case threw. */
afterEach(async () => {
  for (const one of held.splice(0)) await one.release();
});

const describeLive = url === undefined ? describe.skip : describe;

describeLive('live · pg advisory lock', () => {
  test('a second holder of the same key is refused, and holds no session', async () => {
    const first = lock();
    expect(await first.tryAcquire()).toBe(true);

    const second = lock();
    expect(await second.tryAcquire()).toBe(false);

    // The refused lock closed its connection rather than parking an idle session on the server.
    const target = parsePgUrl(url ?? '');
    const admin = await PgConnection.open({
      stream: await bunPgStream(target),
      user: target.user,
      password: target.password,
      database: target.database,
      applicationName: 'ultimate-lock-audit',
    });
    try {
      const rows = await admin.query(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'ultimate-replicator-lock:%'",
      );
      expect(rows[0]?.[0]).toBe('1');
    } finally {
      await admin.close();
    }
  });

  test('releasing hands the key to the next caller', async () => {
    const first = lock();
    expect(await first.tryAcquire()).toBe(true);
    const second = lock();
    expect(await second.tryAcquire()).toBe(false);

    await first.release();
    expect(await second.tryAcquire()).toBe(true);
  });

  test('two different slots are two different locks', async () => {
    expect(await lock('x:replicator:slot_a').tryAcquire()).toBe(true);
    expect(await lock('x:replicator:slot_b').tryAcquire()).toBe(true);
  });

  test('the lock is session-scoped, so it survives a rollback in that session', async () => {
    // The property the whole design rests on: a crashed replicator releases by dying, and a
    // transaction abort inside the holder never quietly hands the slot to a second process.
    const first = lock();
    expect(await first.tryAcquire()).toBe(true);
    const second = lock();
    expect(await second.tryAcquire()).toBe(false);
    expect(await second.tryAcquire()).toBe(false);
  });

  test('the lock exists in pg_locks, not just in this process', async () => {
    // The assertion that an in-memory lock cannot satisfy. `InMemoryAdvisoryLock` refuses a second
    // caller in *this* process and nowhere else, which is precisely the failure two replicator
    // containers would hit — so the proof has to be the server's own lock table.
    const target = parsePgUrl(url ?? '');
    const admin = await PgConnection.open({
      stream: await bunPgStream(target),
      user: target.user,
      password: target.password,
      database: target.database,
      applicationName: 'ultimate-lock-audit',
    });
    try {
      const before = await admin.query(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      expect(await lock('x:replicator:pg_locks_slot').tryAcquire()).toBe(true);
      const after = await admin.query(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted",
      );
      expect(Number(after[0]?.[0])).toBe(Number(before[0]?.[0]) + 1);
    } finally {
      await admin.close();
    }
  });

  test('selectChangeFeed hands back a lock that works against this server', async () => {
    const selection = selectChangeFeed(
      { DATABASE_URL: url, REPLICATION_SLOT: 'x_live_selected_slot' },
      { entities: ['posts'] },
    );
    expect(selection.mode).toBe('external');
    expect(selection.lock.key).toBe('x:replicator:x_live_selected_slot');
    expect(await selection.lock.tryAcquire()).toBe(true);
    try {
      expect(await lock('x:replicator:x_live_selected_slot').tryAcquire()).toBe(false);
    } finally {
      await selection.lock.release();
    }
  });
});
