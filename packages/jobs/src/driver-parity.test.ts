// One question, one answer, whichever driver is asked. `driver-memory.ts` is what `x dev`, every
// test in this repo and every test in an app runs against; `driver-pg.ts` is what production runs
// against — so a semantic only one of them holds is a guarantee that passes CI and breaks on
// deploy. Each case asserts the memory driver's BEHAVIOUR and the pg statement that has to mean
// the same thing, in one test, so neither side can move alone.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_NACK } from './driver-pg-sql';

/** The pg driver compiles its SQL against this seam, so the statement it issues is readable. */
function recordingExecutor(): PgExecutor & { readonly sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    query<R>(text: string): Promise<readonly R[]> {
      sql.push(text);
      return Promise.resolve([] as readonly R[]);
    },
  };
}

const claimOne = (driver: JobDriver): Promise<unknown> =>
  driver.claim({ queues: ['default'], limit: 1, visibilityTimeoutMs: 30_000, workerId: 'w1' });

describe('attempt never goes below zero', () => {
  test('a suspension that does not burn an attempt cannot drive the count negative', async () => {
    const driver = createMemoryDriver();
    const { id } = await driver.enqueue({
      name: 'sleeper',
      queue: 'default',
      input: {},
      idempotencyKey: 'sleeper:1',
      maxAttempts: 3,
    });

    // A `step.sleep` loop is one claim and one suspension per pass, and each pass gives the
    // attempt back: three of them on a fresh row is `0 -> 1 -> 0`, three times, never `-1`. A
    // negative attempt is a row `nextRetry` reads as having tries it does not have.
    for (let pass = 0; pass < 3; pass += 1) {
      await claimOne(driver);
      await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    }
    expect((await driver.introspect?.job(id))?.attempt).toBe(0);

    // Two guards, and this asks for both: the settle fence refuses a nack on a row that is not
    // `running` (a suspended row is already back on the queue), and the decrement itself has a
    // floor. Drop either and this row reaches `-1`.
    await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    await driver.nack(id, { delayMs: 0, countsAsAttempt: false });
    expect((await driver.introspect?.job(id))?.attempt).toBe(0);
    // The floor the pg driver has always had. Both halves in one test: dropped from either side,
    // this fails.
    expect(SQL_NACK).toContain('greatest(attempt - 1, 0)');
  });
});

describe('introspect.list answers newest first', () => {
  test('the memory driver orders by createdAt descending, as the pg statement does', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = createMemoryDriver({ clock });
    for (const key of ['oldest', 'middle', 'newest']) {
      await driver.enqueue({
        name: 'listed',
        queue: 'default',
        input: {},
        idempotencyKey: `listed:${key}`,
        maxAttempts: 1,
      });
      clock.advance(1_000);
    }

    // `x jobs ls`, `/_x`'s jobs panel and the MCP tool all read whichever driver the process
    // wired: ascending here meant an operator comparing a dev list with a production one was
    // shown two different halves of the queue.
    expect(((await driver.introspect?.list()) ?? []).map((row) => row.idempotencyKey)).toEqual([
      'listed:newest',
      'listed:middle',
      'listed:oldest',
    ]);

    const executor = recordingExecutor();
    await createPgDriver({ executor }).introspect?.list();
    expect(executor.sql.join('\n')).toContain('order by created_at desc');
  });

  test('a limit keeps the newest rows, not the oldest', async () => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = createMemoryDriver({ clock });
    for (const key of ['a', 'b', 'c']) {
      await driver.enqueue({
        name: 'listed',
        queue: 'default',
        input: {},
        idempotencyKey: `listed:${key}`,
        maxAttempts: 1,
      });
      clock.advance(1_000);
    }

    // The limit is applied AFTER the sort in both drivers, so sorting the wrong way did not just
    // reverse the page — it returned the rows least likely to be asked about.
    expect(
      ((await driver.introspect?.list({ limit: 1 })) ?? []).map((row) => row.idempotencyKey),
    ).toEqual(['listed:c']);
  });
});
