// `backfill()` is a factory over `job()`, so what this file pins is the DECLARATION: the handle it
// returns is a real registered job, keyed by the durable name, and a batch size that is not a whole
// number of rows is refused where it was written. The pass itself is `backfill-pass.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import { backfill } from './backfill';
import { getJob, isJobHandle, resetJobs } from './job';

const rows = entity('backfill_factory_rows', {
  columns: { id: uuid().primaryKey(), orgId: uuid(), title: text({ max: 40 }) },
});

type Row = typeof rows.$row;

const ORG = '00000000-0000-7000-8000-0000000000a1';

const source = () => tableFor(rows, memoryRepo(rows, [])).where({ orgId: ORG });

beforeEach(() => {
  resetJobs();
});

describe('the factory', () => {
  test('returns a registered job handle keyed by the declared name', () => {
    const handle = backfill<Row>({
      name: 'rewrite-titles',
      queue: 'maintenance',
      retry: { attempts: 7, backoff: 'fixed' },
      source,
      handle: () => undefined,
    });

    expect(isJobHandle(handle)).toBe(true);
    expect(getJob('rewrite-titles')).toBe(handle);
    expect(handle.queue).toBe('maintenance');
    expect(handle.retry.attempts).toBe(7);
    // One live run per name: a second enqueue while the pass is going is the same pass.
    expect(handle.idempotencyKeyFor({})).toBe('rewrite-titles');
  });

  test('refuses a batch size that is not a whole number of rows, where it was written', () => {
    for (const batch of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        backfill<Row>({
          name: `bad-${String(batch)}`,
          batch,
          source,
          handle: () => undefined,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isUltimateError(thrown)).toBe(true);
      expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT');
      // Refused before `job()` ran, so the name is still free for the corrected definition.
      expect(getJob(`bad-${String(batch)}`)).toBeUndefined();
    }
  });

  test('refuses a rate that is not batches per second, where it was written', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      let thrown: unknown;
      try {
        backfill<Row>({
          name: `unpaced-${String(rate)}`,
          rate,
          source,
          handle: () => undefined,
        });
      } catch (error) {
        thrown = error;
      }
      expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_INVARIANT');
      // Not one statement into a dead-lettered job: an unpaced sweep saturates the pool, and the
      // app finds out before the queue does.
      expect(getJob(`unpaced-${String(rate)}`)).toBeUndefined();
    }
  });

  test('a fraction is a rate too — one batch every two seconds', () => {
    // Unlike `batch`, which is a whole number of rows: this one is a frequency, and a backfill
    // slower than one batch a second is exactly what a hot table wants.
    const handle = backfill<Row>({
      name: 'slow-and-steady',
      rate: 0.5,
      source,
      handle: () => undefined,
    });

    expect(getJob('slow-and-steady')).toBe(handle);
  });
});
