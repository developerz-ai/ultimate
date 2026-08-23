// `purge()` is a factory over `job()`, so half of what matters here is that the handle it returns
// is an ordinary job — the other half is the two things a retention sweep gets wrong on its own:
// the clock it measures with, and re-sweeping a table a killed attempt already checkpointed.

import { afterEach, describe, expect, test } from 'bun:test';
import { createContext, frozenClock, isUltimateError } from '@ultimat3/core';
import { resetJobs } from './job';
import type { PurgeReport, PurgeTarget } from './purge';
import { DEFAULT_PURGE_CRON, purge } from './purge';
import type { StepStore } from './steps';
import { createMemoryStepStore, createStepRunner } from './steps';

const START_MS = 1_700_000_000_000;

/** A table that records the clock it was measured against and how often it was swept. */
function countingTarget(name: string, removed: number): PurgeTarget & { readonly at: number[] } {
  const at: number[] = [];
  return {
    name,
    at,
    purgeExpired: async (nowMs: number): Promise<number> => {
      at.push(nowMs);
      return removed;
    },
  };
}

/** One attempt, over a step store the caller keeps — a second call replays what the first wrote. */
async function attempt(
  handle: ReturnType<typeof purge>,
  store: StepStore,
  runId = 'run-1',
): Promise<PurgeReport> {
  const runner = createStepRunner({ runId, jobName: handle.name, store });
  const result = await handle.run({
    input: {},
    step: runner.step,
    ctx: createContext({ role: 'worker' }),
    attempt: 1,
    jobId: 'job-1',
    runId,
  });
  return result as PurgeReport;
}

const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
  } catch (error) {
    return isUltimateError(error) ? error.code : `not-an-UltimateError: ${typeof error}`;
  }
  return 'did-not-throw';
};

afterEach(() => {
  resetJobs();
});

describe('purge()', () => {
  test('returns a job handle, never a ninth kind of thing', () => {
    const handle = purge({ name: 'retention', targets: () => [] });
    expect(handle.kind).toBe('job');
    // One live sweep at a time: two deletes racing over one table buy nothing but lock contention.
    expect(handle.idempotencyKeyFor({})).toBe('purge');
    // Framework tables span every org, so the pass belongs to no tenant.
    expect(handle.tenantFor({})).toBeUndefined();
  });

  test('measures every target against ONE reading of the declared clock', async () => {
    const clock = frozenClock(START_MS);
    const first = countingTarget('x_rate_limit', 2);
    const second = countingTarget('x_idempotency', 3);
    const handle = purge({
      name: 'retention',
      clock,
      targets: () => {
        // Moved between the two reads. A sweep that called `clock.now()` per target — or worse,
        // let each store read the server's — would measure the two tables an interval apart.
        clock.advance(60_000);
        return [first, second];
      },
    });

    const report = await attempt(handle, createMemoryStepStore());

    expect(first.at).toEqual([START_MS]);
    expect(second.at).toEqual([START_MS]);
    expect(report).toEqual({
      swept: [
        { name: 'x_rate_limit', removed: 2 },
        { name: 'x_idempotency', removed: 3 },
      ],
      removed: 5,
    });
  });

  test('a resumed attempt does not sweep a table the last one checkpointed', async () => {
    const clock = frozenClock(START_MS);
    const kept = countingTarget('x_rate_limit', 2);
    const failing: PurgeTarget = {
      name: 'x_auth',
      purgeExpired: (): Promise<number> => Promise.reject(new TypeError('connection reset')),
    };
    let targets: readonly PurgeTarget[] = [kept, failing];
    const handle = purge({ name: 'retention', clock, targets: () => targets });
    const store = createMemoryStepStore();

    await attempt(handle, store).catch(() => undefined);
    expect(kept.at).toHaveLength(1);

    targets = [kept, countingTarget('x_auth', 4)];
    const report = await attempt(handle, store);

    // Still one: the second attempt replayed `x_rate_limit`'s checkpoint instead of deleting
    // again. A purge is idempotent, so a re-sweep is safe — it is just a table scan nobody
    // needed, per table, on every retry of a long pass.
    expect(kept.at).toHaveLength(1);
    expect(report.removed).toBe(6);
  });

  test('two targets under one name are refused before the first delete', async () => {
    const handle = purge({
      name: 'retention',
      targets: () => [countingTarget('x_auth', 1), countingTarget('x_auth', 1)],
    });
    // `step.run` would raise `X_STEP_DUPLICATE` on the second one — after the first table had
    // already been emptied by a pass that then dead-letters.
    expect(await codeOf(attempt(handle, createMemoryStepStore()))).toBe('X_INVARIANT');
  });

  test('an empty target list is a pass that removes nothing', async () => {
    const handle = purge({ name: 'retention', targets: () => [] });
    expect(await attempt(handle, createMemoryStepStore())).toEqual({ swept: [], removed: 0 });
  });

  test('the shipped cron is hourly and off the hour', () => {
    // Off the top of the hour on purpose: every other framework-shipped schedule an operator adds
    // lands there, and a retention sweep is the one that holds locks on hot tables.
    expect(DEFAULT_PURGE_CRON).toBe('23 * * * *');
  });
});
