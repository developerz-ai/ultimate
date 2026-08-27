// The other half of `pool-drain.test.ts`: that one asserts what `close()` ASKS the driver for,
// this one asserts the driver honours it. Only a real server can answer — a fake pool's `close()`
// is whatever the fake decided, and the whole finding (#394) is that the REAL one waits forever on
// an outstanding reserved connection. Skips unless `TEST_DATABASE_URL` is set.

import { describe, expect, test } from 'bun:test';
import { createPostgresClient, type PostgresClient } from './client';
import type { DbError } from './errors';
import { sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;

describe.skipIf(!hasPostgres)('live · postgres · a drain that cannot finish still ends', () => {
  const client = (drainTimeoutMs: number): PostgresClient =>
    createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 2, drainTimeoutMs } });

  test('close() gives up on a reserve nobody released, and says so', async () => {
    // The shape `releaseQueue` hit in `dev-runtime.live.test.ts`: a shutdown runs while a
    // connection is still pinned. Measured before the bound, three runs per case: `end()` never
    // returns — on Bun 1.3.14 AND 1.4.0, with the database perfectly healthy.
    const db = client(1_000);
    const pinned = await db.reserve();
    expect(await pinned.query(sql`select 1 as ok`)).toHaveLength(1);

    const started = performance.now();
    let thrown: unknown;
    try {
      await db.close();
    } catch (error) {
      thrown = error;
    }
    const elapsed = performance.now() - started;

    // The assertion is that it RETURNED at all. The upper bound is generous on purpose — this runs
    // beside every other live suite — but it is finite, which is the entire property under test.
    expect(elapsed).toBeLessThan(15_000);
    expect((thrown as DbError | undefined)?.code).toBe('X_DB_DRAIN_TIMEOUT');
    pinned.release();
  });

  test('and a pool with nothing outstanding drains well inside its budget', async () => {
    // The other direction, and the one that would catch a `timeout` in the wrong unit: 5000 read as
    // seconds is an eighty-three minute budget, so a bounded close and a hung one look identical
    // from a test that only asserts the failure path.
    const db = client(5_000);
    await db.ping();
    const started = performance.now();
    await db.close();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
