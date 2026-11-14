// The finished-job sweep's cadence, over a recording executor: which statements a pass sends, by
// the job's clock. The statements themselves are proven against Postgres in the `.job.` suite.

import { describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import {
  jobsPurgeTarget,
  SQL_JOBS_RETENTION_BATCH,
  SQL_JOBS_RETENTION_ORPHANS,
} from './jobs-retention';
import { PURGE_UPKEEP_EVERY_MS } from './purge';

const HOUR_MS = 3_600_000;
const T0 = Date.UTC(2026, 10, 12, 0, 23);

function recording(): { readonly executor: PgExecutor; readonly sent: string[] } {
  const sent: string[] = [];
  const executor: PgExecutor = {
    query: <R>(text: string): Promise<readonly R[]> => {
      sent.push(text);
      const rows =
        text === SQL_JOBS_RETENTION_BATCH
          ? [{ removed: 0, held: '[]', done_after: null, ended_after: null }]
          : [];
      return Promise.resolve(rows as unknown as readonly R[]);
    },
  };
  return { executor, sent };
}

const orphanPasses = (sent: readonly string[]): number =>
  sent.filter((text) => text === SQL_JOBS_RETENTION_ORPHANS).length;

describe('the orphan step pass', () => {
  test('runs on the first pass, then at most once a day of the job clock', async () => {
    const { executor, sent } = recording();
    const target = jobsPurgeTarget({ executor, doneRetentionMs: 1, deadRetentionMs: 1 });
    // The hourly cron, for a day: one orphan scan, not twenty-four.
    for (let hour = 0; hour < 24; hour += 1) await target.purgeExpired(T0 + hour * HOUR_MS);
    expect(orphanPasses(sent)).toBe(1);
    expect(sent.filter((text) => text === SQL_JOBS_RETENTION_BATCH)).toHaveLength(24);
    await target.purgeExpired(T0 + PURGE_UPKEEP_EVERY_MS);
    expect(orphanPasses(sent)).toBe(2);
  });

  test('the cadence is a day', () => {
    expect(PURGE_UPKEEP_EVERY_MS).toBe(24 * HOUR_MS);
  });

  test('a clock that steps back does not re-run it', async () => {
    const { executor, sent } = recording();
    const target = jobsPurgeTarget({ executor, doneRetentionMs: 1, deadRetentionMs: 1 });
    await target.purgeExpired(T0);
    await target.purgeExpired(T0 - HOUR_MS);
    expect(orphanPasses(sent)).toBe(1);
  });
});

describe('the keyset between batches', () => {
  /** A batch executor answering scripted rows, recording each batch's `$4`/`$5`. */
  function scripted(answers: readonly { removed: number; done_after: string | null }[]): {
    readonly executor: PgExecutor;
    readonly seeks: (readonly unknown[])[];
  } {
    const seeks: (readonly unknown[])[] = [];
    let next = 0;
    const executor: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
        if (text !== SQL_JOBS_RETENTION_BATCH) return Promise.resolve([]);
        seeks.push(values.slice(3));
        const answer = answers[next] ?? { removed: 0, done_after: null };
        next += 1;
        const row = { ...answer, held: '[]', ended_after: null };
        return Promise.resolve([row] as unknown as readonly R[]);
      },
    };
    return { executor, seeks };
  }

  test('each batch seeks from the newest row the batch before deleted, across passes', async () => {
    const { executor, seeks } = scripted([
      { removed: 2, done_after: 't1' },
      { removed: 1, done_after: 't2' },
      { removed: 0, done_after: null },
    ]);
    const target = jobsPurgeTarget({
      executor,
      doneRetentionMs: 1,
      deadRetentionMs: 1,
      batchSize: 2,
    });
    await target.purgeExpired(T0);
    await target.purgeExpired(T0 + HOUR_MS);
    await target.purgeExpired(T0 + 2 * HOUR_MS);
    // A batch that deleted nothing from a branch keeps that branch's mark.
    expect(seeks).toEqual([
      [null, null],
      ['t1', null],
      ['t2', null],
      ['t2', null],
    ]);
  });

  test('the daily upkeep forgets the marks, so a row skipped below one gets its turn', async () => {
    const { executor, seeks } = scripted([{ removed: 1, done_after: 't1' }]);
    const target = jobsPurgeTarget({ executor, doneRetentionMs: 1, deadRetentionMs: 1 });
    await target.purgeExpired(T0);
    await target.purgeExpired(T0 + HOUR_MS);
    await target.purgeExpired(T0 + PURGE_UPKEEP_EVERY_MS);
    expect(seeks).toEqual([
      [null, null],
      ['t1', null],
      [null, null],
    ]);
  });
});
