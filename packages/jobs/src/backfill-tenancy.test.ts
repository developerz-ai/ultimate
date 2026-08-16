// What tenant a `backfill()` pass sweeps under, driven through the REAL surface — `executeJob`,
// which is what installs the ambient context a plan is scoped from. The fixture the other backfill
// suites share calls `backfillPass` directly, so it runs with no ambient context at all and cannot
// see this: `scopedPlan` is applied when each page's plan is BUILT, which happens inside the
// iteration, long after the declaring frame closed.
//
// Two declarations, two answers, and the negative is the half that matters most: `tenant: 'none'`
// sweeps every tenant, and a backfill that declared a real tenant must NOT inherit that escape.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, isUltimateError, userActor } from '@ultimat3/core';
import type { ReadBuilder } from '@ultimat3/entity';
import { clearRegistry, entity, memoryRepo, tableFor, text, uuid } from '@ultimat3/entity';
import type { BackfillInput } from './backfill';
import { backfill } from './backfill';
import type { ClaimedJob, JobDriver } from './driver';
import { resetJobDriver, setJobDriver } from './driver';
import { createMemoryDriver } from './driver-memory';
import { executeJob } from './execute';
import type { AnyJobHandle } from './job';
import { resetJobs } from './job';

const posts = entity('bf_tenancy_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 40 }),
  },
});

type Post = typeof posts.$row;

const idAt = (index: number): string =>
  `00000000-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`;
const ORG_A = '00000000-0000-7000-8000-0000000000a1';
const ORG_B = '00000000-0000-7000-8000-0000000000a2';

/** Six rows for A and four for B, so "swept everything" and "swept one tenant" differ by count. */
const SEED: readonly Post[] = [
  ...Array.from({ length: 6 }, (_u, index) => ({
    id: idAt(index * 10),
    orgId: ORG_A,
    title: `a-${index}`,
  })),
  ...Array.from({ length: 4 }, (_u, index) => ({
    id: idAt(500 + index * 10),
    orgId: ORG_B,
    title: `b-${index}`,
  })),
];

let table: ReturnType<typeof tableFor<Post, typeof posts.$columns>>;
let driver: JobDriver;

/** Everything one pass handed its `handle`, in order, plus how many pages it took. */
interface Sweep {
  readonly outcome: string;
  readonly rows: readonly Post[];
  readonly pages: number;
}

/**
 * One pass, run the way the worker runs it: enqueued, claimed and executed through `executeJob`,
 * because that is the frame that installs the ambient context. Calling `backfillPass` by hand — as
 * the shared fixture does — runs with no context and proves nothing about tenancy.
 */
const sweep = async (handle: AnyJobHandle, seen: Post[], pages: () => number): Promise<Sweep> => {
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input: {} satisfies BackfillInput,
    idempotencyKey: handle.name,
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'w1',
  });
  if (claimed === undefined) throw new Error('the driver claimed nothing');
  const execution = await executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle,
    // What a worker builds: a context with an actor and NO org. The declaration is the only
    // thing that can put one on the run.
    ctx: createContext({ role: 'worker', actor: userActor({ id: 'worker-1' }) }),
  });
  return {
    outcome: execution.outcome === 'completed' ? 'completed' : (execution.error ?? 'failed'),
    rows: seen,
    pages: pages(),
  };
};

/** A declaration over the whole table, batched small enough that one page cannot be the answer. */
const declare = (name: string, tenant: (() => string) | 'none') => {
  const seen: Post[] = [];
  let pages = 0;
  const handle = backfill<Post>({
    name,
    tenant,
    batch: 2,
    // Fast enough that the pacer is not what this test measures.
    rate: 1_000,
    source: (): ReadBuilder<Post> => table,
    handle: ({ rows }) => {
      pages += 1;
      seen.push(...rows);
    },
  });
  return { handle: handle as AnyJobHandle, seen, pages: () => pages };
};

beforeEach(() => {
  resetJobs();
  table = tableFor(posts, memoryRepo(posts, SEED));
  driver = createMemoryDriver();
  setJobDriver(driver);
});

afterEach(() => {
  resetJobDriver();
});

afterAll(() => {
  resetJobs();
  clearRegistry();
});

describe("a backfill declaring tenant: 'none' sweeps every tenant", () => {
  test('a multi-page pass over a tenant-scoped entity completes and visits every row', async () => {
    const declared = declare('bf-sweep-all', 'none');
    const result = await sweep(declared.handle, declared.seen, declared.pages);

    // Before the pass opened its own cross-tenant scope this failed on page ONE with
    // `X_TENANCY_ACTOR_ORG_REQUIRED`: the run's actor carries no org, so `scopedPlan` had no
    // tenant to derive and nothing had lifted the guard.
    expect(result.outcome).toBe('completed');
    expect(result.rows).toHaveLength(SEED.length);
    expect(new Set(result.rows.map((row) => row.orgId))).toEqual(new Set([ORG_A, ORG_B]));
    // Genuinely multi-page: a scope that only covered the first statement would pass a one-page
    // test and fail on the second batch's plan.
    expect(result.pages).toBeGreaterThan(1);
  });

  test('the scope does not outlive the pass — the run is left with no cross-tenant capability', async () => {
    const declared = declare('bf-sweep-scoped-out', 'none');
    await sweep(declared.handle, declared.seen, declared.pages);

    // Nothing ambient survives `executeJob`, so a read out here is refused exactly as it was
    // before the pass ran. An `X_TENANCY_*` code either way — never rows.
    const escaped = await table
      .all()
      .then(() => 'ACCEPTED')
      .catch((error: unknown) => (isUltimateError(error) ? error.code : String(error)));
    expect(escaped).not.toBe('ACCEPTED');
  });
});

describe('a backfill declaring a real tenant does NOT run cross-tenant', () => {
  test('the pass sees its own org only, and never the escape hatch', async () => {
    const declared = declare('bf-sweep-one-org', () => ORG_A);
    const result = await sweep(declared.handle, declared.seen, declared.pages);

    expect(result.outcome).toBe('completed');
    // Six, not ten: `scopedPlan` derived `orgId = ORG_A` from the run's actor, which is what a
    // cross-tenant scope would have skipped.
    expect(result.rows).toHaveLength(6);
    expect(new Set(result.rows.map((row) => row.orgId))).toEqual(new Set([ORG_A]));
    expect(result.pages).toBeGreaterThan(1);
  });

  test('a page naming another org is still refused inside a tenanted pass', async () => {
    let verdict = 'never ran';
    const handle = backfill<Post>({
      name: 'bf-sweep-refuses-other',
      tenant: () => ORG_A,
      batch: 10,
      rate: 1_000,
      source: (): ReadBuilder<Post> => table,
      handle: async () => {
        verdict = await table
          .where({ orgId: ORG_B })
          .all()
          .then(() => 'ACCEPTED')
          .catch((error: unknown) => (isUltimateError(error) ? error.code : String(error)));
      },
    });
    await sweep(handle as AnyJobHandle, [], () => 0);

    expect(verdict).toBe('X_TENANCY_ACTOR_MISMATCH');
  });
});
