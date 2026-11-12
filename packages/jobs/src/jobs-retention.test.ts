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
      const rows = text === SQL_JOBS_RETENTION_BATCH ? [{ removed: 0, held: '[]' }] : [];
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
