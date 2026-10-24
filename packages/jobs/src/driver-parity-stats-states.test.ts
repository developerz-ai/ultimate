// Which rows `stats()` reads, in both drivers: the six states a bucket counts, and nothing else.
// `SQL_STATS` runs every 15 s on every worker, so it must be an index range over the counted rows
// and not a pass over the fortnight of `done` ones the retention window keeps (prod, 2026-10-24:
// 29 ms mean over 48k rows, 22 of them counted). Split from `driver-parity.test.ts` at its ceiling.

import { describe, expect, test } from 'bun:test';
import { STATS_STATES } from './driver';
import { memoryJobDriver } from './driver-memory';
import { SQL_JOBS_TABLE, SQL_STATS } from './driver-pg-sql';

/** Both statements are aligned for a human reading a log; matched whitespace-collapsed. */
const compact = (sql: string): string => sql.replace(/\s+/g, ' ');

describe('stats reads only the states it counts', () => {
  // A queue whose every row is `done` or `cancelled` is therefore not listed — and the memory
  // driver must not list it either, or `x jobs` answers differently under `x dev`.
  test('a queue holding only done and cancelled rows is listed by neither', async () => {
    const driver = memoryJobDriver();
    const enqueue = (queue: string, key: string) =>
      driver.enqueue({ name: 'probe', queue, input: {}, idempotencyKey: key, maxAttempts: 3 });
    const { id: finished } = await enqueue('mail', 'mail:1');
    await driver.claim({ queues: ['mail'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' });
    expect(await driver.ack(finished, { workerId: 'w1', claim: 1 })).toBe(true);
    const { id: dropped } = await enqueue('mail', 'mail:2');
    await driver.introspect?.cancel?.(dropped);
    await enqueue('default', 'default:1');
    expect((await driver.introspect?.job(dropped))?.state).toBe('cancelled');
    expect((await driver.stats()).map((row) => row.queue)).toEqual(['default']);

    // The pg half: one `where`, naming exactly the states the memory driver counts, and the
    // partial index spelling the same list — a predicate the index does not imply is a seq scan.
    const counted = [...STATS_STATES].map((state) => `'${state}'`).join(', ');
    expect(compact(SQL_STATS)).toContain(`from x_jobs where state in (${counted}) group by queue`);
    expect(compact(SQL_JOBS_TABLE)).toContain(
      `create index if not exists x_jobs_depth_idx on x_jobs (queue, state, run_at) where state in (${counted})`,
    );
  });
});
