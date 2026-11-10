// Memory and Postgres agree on what a row limit counts. Split out of `driver-parity.test.ts` at the
// file ceiling. What a step answers is `stepStoreConformance` (`@ultimat3/testing`), on every driver.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import type { JobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { postgresJobDriver } from './driver-pg';

/**
 * The pg driver compiles its SQL against this seam, so the statement it issues is readable — and
 * its PARAMETERS with it, because a value the statement takes as `$n` (the state a nack writes) is
 * decided in the driver and is invisible in the SQL.
 */
function recordingExecutor(): PgExecutor & {
  readonly sql: string[];
  readonly params: readonly unknown[][];
} {
  const sql: string[] = [];
  const params: unknown[][] = [];
  return {
    sql,
    params,
    query<R>(text: string, values: readonly unknown[] = []): Promise<readonly R[]> {
      sql.push(text);
      params.push([...values]);
      return Promise.resolve([] as readonly R[]);
    },
  };
}

describe('a row limit is a count of rows, in both', () => {
  /**
   * The divergence: `introspect.list({ limit: -1 })` did `.slice(0, -1)` on the memory driver and
   * answered every row BUT the newest — a page that looks like data — while the pg driver bound
   * the same `-1` into `limit $4`, where Postgres answers `ERROR: LIMIT must not be negative`
   * (probed on a live pg18: `select 1 limit -1`). A fraction diverges the other way and silently:
   * `.slice(0, 2.5)` keeps 2 rows, `limit 2.5` keeps 3 (measured on the same server). `NaN` and
   * `Infinity` are `[]` here and `invalid input syntax for type bigint` there.
   *
   * `finiteOption` could not see any of it — every one of those values is finite except `NaN`.
   * The screen has to be the COUNT one, with a minimum of zero: `limit: 0` means zero rows on both
   * (`.slice(0, 0)` and `limit 0`), so it is the one edge the two drivers already agree on.
   */
  const NOT_A_ROW_COUNT: readonly number[] = [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];

  const threeRows = async (): Promise<JobDriver> => {
    const clock = frozenClock(1_700_000_000_000);
    const driver = memoryJobDriver({ clock });
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
    return driver;
  };

  test('the memory driver REJECTS a limit that is not a count, rather than answering a page', async () => {
    const driver = await threeRows();
    for (const limit of NOT_A_ROW_COUNT) {
      // `rejects`, never a synchronous throw: `list` is typed `Promise<…>` and the pg driver
      // rejects, so a sync throw out of this one is itself the divergence — the same reason
      // `claim` is `async` here.
      await expect(driver.introspect?.list({ limit })).rejects.toThrow(/X_INVARIANT/);
    }
    await expect(driver.introspect?.deadLetters(-1)).rejects.toThrow(/X_INVARIANT/);
  });

  test('the pg driver refuses the same values BEFORE it issues a statement', async () => {
    for (const limit of NOT_A_ROW_COUNT) {
      const executor = recordingExecutor();
      await expect(postgresJobDriver({ executor }).introspect?.list({ limit })).rejects.toThrow(
        /X_INVARIANT/,
      );
      // Refused in the driver: `LIMIT must not be negative` is a round trip that reads as an
      // outage, and `limit 2.5` is not refused by Postgres at all — it silently returns 3 rows.
      expect(executor.sql).toEqual([]);
    }
    const executor = recordingExecutor();
    await expect(postgresJobDriver({ executor }).introspect?.deadLetters(2.5)).rejects.toThrow(
      /X_INVARIANT/,
    );
    expect(executor.sql).toEqual([]);
  });

  test('a claim limit that is not a count is refused before a single row moves', async () => {
    // The worst of the three: `.slice(0, -1)` on the memory driver CLAIMS every ready row but the
    // newest — a lease taken on work this pass never intended to run — where the pg driver's
    // statement is rejected by the database. `jobWorker` screens its own `concurrency`, so this
    // is the seam an embedder driving `JobDriver` directly reaches.
    const bad = (limit: number) => ({
      queues: ['default'],
      limit,
      visibilityTimeoutMs: 30_000,
      workerId: 'w1',
    });
    for (const limit of NOT_A_ROW_COUNT) {
      await expect(memoryJobDriver().claim(bad(limit))).rejects.toThrow(/X_INVARIANT/);
      const executor = recordingExecutor();
      await expect(postgresJobDriver({ executor }).claim(bad(limit))).rejects.toThrow(
        /X_INVARIANT/,
      );
      expect(executor.sql).toEqual([]);
    }
    // A lease window is a DURATION, not a count, so it is screened for finiteness alone — but it
    // is screened: `visibleAt = at + NaN` is the defect that makes at-least-once never.
    await expect(
      memoryJobDriver().claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: Number.NaN,
        workerId: 'w1',
      }),
    ).rejects.toThrow(/X_INVARIANT/);
  });

  test('zero and a real limit are unchanged, in both — the screen refuses numbers, not pages', async () => {
    // Non-vacuity, and the DOMAIN: `limit: 0` is zero rows on both and stays legal.
    const driver = await threeRows();
    expect(await driver.introspect?.list({ limit: 0 })).toEqual([]);
    expect(
      ((await driver.introspect?.list({ limit: 1 })) ?? []).map((row) => row.idempotencyKey),
    ).toEqual(['listed:c']);
    expect(await driver.introspect?.deadLetters(0)).toEqual([]);
    await expect(
      driver.claim({ queues: ['default'], limit: 0, visibilityTimeoutMs: 30_000, workerId: 'w1' }),
    ).resolves.toEqual([]);

    const executor = recordingExecutor();
    await postgresJobDriver({ executor }).introspect?.list({ limit: 25 });
    expect(executor.params[0]?.[3]).toBe(25);
  });
});
