// `rollup()` declarations `rollup.job.test.ts` does not reach: a key covered by a unique INVARIANT
// (not an index) is accepted, a partial one is not, and the run's idempotency key is one per
// rollup and org — `*` for a rollup spanning orgs.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, integer, invariant, timestamp, uuid } from '@ultimat3/entity';
import { resetJobs } from './job';
import { rollup } from './rollup';

const byInvariant = entity('rollup_decl_daily', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), day: timestamp(), n: integer() },
  invariants: (c) => [invariant('org_day_unique', c.unique(['orgId', 'day']))],
});

const unconstrained = entity('rollup_decl_loose', {
  columns: { id: uuid().primaryKey(), orgId: uuid().tenant(), day: timestamp(), n: integer() },
});

const base = {
  table: () => ({ upsertAll: async () => expect.unreachable('a declaration never writes') }),
  lookback: '1d',
  bucket: { unit: 'day', timeZone: 'UTC' } as const,
  tenant: 'none' as const,
  source: async () => [],
  map: () => ({}),
};

afterAll(() => {
  resetJobs();
  clearRegistry();
});

describe('rollup declaration', () => {
  test('a key covered by a unique invariant is accepted', () => {
    const handle = rollup({ ...base, name: 'r-inv', into: byInvariant, key: ['orgId', 'day'] });
    expect(handle.name).toBe('r-inv');
  });

  test('the same key on a table with no unique constraint over it is refused', () => {
    expect(() =>
      rollup({ ...base, name: 'r-loose', into: unconstrained, key: ['orgId', 'day'] }),
    ).toThrow(
      expect.objectContaining({
        code: 'X_JOB_ROLLUP_INVALID',
        message: expect.stringContaining('no unique constraint on rollup_decl_loose covers'),
      }),
    );
  });

  test("a run's idempotency key is one per rollup and org, * when it spans orgs", () => {
    const handle = rollup({ ...base, name: 'r-key', into: byInvariant, key: ['orgId', 'day'] });
    expect(handle.idempotencyKeyFor({ orgId: 'org-1' })).toBe('rollup:r-key:org-1');
    expect(handle.idempotencyKeyFor({})).toBe('rollup:r-key:*');
  });
});
