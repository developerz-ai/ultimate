// Single responsibility: the advisory lock in migrate.ts against a real Postgres. A recording
// client cannot distinguish "every statement ran on the session that took the lock" from "the
// lock landed on whichever connection the pool lent for one statement" — the two produce
// identical statement text and only Postgres' own lock bookkeeping tells them apart. Skips unless
// `TEST_DATABASE_URL` is set, the same convention as `pg-driver.live.test.ts`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import { LEDGER_TABLE, type Migration, migrate } from './migrate';
import { raw } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · migrate advisory lock', () => {
  const clients: PostgresClient[] = [];

  const freshClient = (): PostgresClient => {
    const client = createPostgresClient({ url: url ?? '' });
    clients.push(client);
    return client;
  };

  beforeEach(async () => {
    await freshClient().execute(raw(`drop table if exists ${LEDGER_TABLE}`));
  });

  afterEach(async () => {
    // Closing every pool ends its backends — which is exactly what makes a broken unlock (landed
    // on the wrong session) visible: the lock only ever clears here, never on its own, so a test
    // that left one stuck would wedge every test after it instead of just failing this one.
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  const slowMigration: Migration = {
    id: '20260101000000_live_lock_probe',
    name: 'live lock probe',
    up: 'select pg_sleep(0.3)',
    down: 'select 1',
  };

  test('two concurrent migrate() calls serialize: one applies, the other skips, never both', async () => {
    // Two independent pools, standing in for two migrator processes — a deploy's rolling
    // restart, not two callers sharing one pinned connection by accident.
    const a = freshClient();
    const b = freshClient();
    const started = performance.now();

    const [first, second] = await Promise.all([
      migrate({ migrations: [slowMigration], client: a }),
      migrate({ migrations: [slowMigration], client: b }),
    ]);

    // A broken lock lets both callers read an empty ledger before either commits, and both
    // then try to insert the same primary key — this `Promise.all` rejecting with a
    // unique-violation is exactly what that looks like, and either report double-counting
    // `applied` is the same race without the crash.
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeGreaterThanOrEqual(280);

    const reports = [first, second];
    const applied = reports.filter((report) => report.applied.length === 1);
    const skipped = reports.filter((report) => report.skipped.length === 1);
    expect(applied).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(applied[0]?.applied[0]?.id).toBe(slowMigration.id);
    expect(skipped[0]?.skipped[0]).toBe(slowMigration.id);
  }, 15_000);

  test('the lock is released after a migration fails, so the next migrate() does not hang', async () => {
    const broken: Migration = {
      id: '20260101000100_live_lock_failure',
      name: 'broken up sql',
      up: 'this is not sql',
      down: 'select 1',
    };

    await expect(migrate({ migrations: [broken], client: freshClient() })).rejects.toThrow();

    // If the unlock landed on a session other than the one that took the lock — the defect
    // the pin closes — the true holder sits idle in the pool still holding it, and this
    // second call blocks until that connection's idle timeout fires instead of finishing in
    // ~0.3s.
    const startedSecond = performance.now();
    const report = await migrate({ migrations: [slowMigration], client: freshClient() });
    const elapsedMs = performance.now() - startedSecond;

    expect(report.applied.map((applied) => applied.id)).toEqual([slowMigration.id]);
    expect(elapsedMs).toBeLessThan(3_000);
  }, 15_000);
});
