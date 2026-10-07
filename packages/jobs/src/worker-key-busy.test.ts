// One run refused by its concurrency key, at the two edges of the settle: a nack that did NOT
// land (the claim lapsed, the row is another worker's) is nobody's refusal to count, and a
// worker `context()` that throws must not turn a refusal already written into a failed round.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import type { ClaimedJob, JobDriver } from './driver';
import { job, resetJobs } from './job';
import { refuseKeyBusy } from './worker-key-busy';

const passthrough: StandardSchemaV1<unknown, { readonly account: string }> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as { readonly account: string } }),
  },
};

afterEach(() => {
  resetJobs();
});

const claimed = {
  id: 'job-1',
  runId: 'run-1',
  name: 'syncAccount',
  queue: 'default',
  input: { account: 'a1' },
  attempt: 1,
  claim: 1,
  claimedBy: 'w1',
} as ClaimedJob;

function fixture(nackLands: boolean) {
  const announced: string[] = [];
  job({
    tenant: 'none',
    name: 'syncAccount',
    input: passthrough,
    idempotencyKey: ({ account }) => `sync:${account}`,
    retry: { attempts: 3 },
    concurrency: { key: ({ account }) => account, limit: 1, whenBusy: 'fail' },
    run: () => Promise.resolve(),
    onSettled: ({ outcome }) => {
      announced.push(outcome);
      return Promise.resolve();
    },
  });
  const nacks: unknown[] = [];
  const driver = {
    name: 'fake',
    nack(_id: string, options: unknown) {
      nacks.push(options);
      return Promise.resolve(nackLands);
    },
  } as unknown as JobDriver;
  return { driver, nacks, announced };
}

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

describe('a run refused by its key', () => {
  test('a refusal that landed is answered, and announced once', async () => {
    const { driver, announced } = fixture(true);
    const execution = await refuseKeyBusy({
      driver,
      claimed,
      key: 'a1',
      limit: 1,
      workerId: 'w1',
      context,
    });
    expect(execution?.outcome).toBe('refused');
    expect(announced).toEqual(['refused']);
  });

  test('a nack that did NOT land is no refusal: nothing to count, nothing announced', async () => {
    const { driver, nacks, announced } = fixture(false);
    const execution = await refuseKeyBusy({
      driver,
      claimed,
      key: 'a1',
      limit: 1,
      workerId: 'w1',
      context,
    });
    expect(nacks).toHaveLength(1);
    expect(execution).toBeUndefined();
    expect(announced).toEqual([]);
  });

  test('a context() that throws leaves the landed refusal standing and answers it', async () => {
    const { driver, announced } = fixture(true);
    const execution = await refuseKeyBusy({
      driver,
      claimed,
      key: 'a1',
      limit: 1,
      workerId: 'w1',
      context: () => {
        throw new TypeError('app context blew up');
      },
    });
    expect(execution?.outcome).toBe('refused');
    // No scope to run the hook in, so it is not run — logged, never thrown into the claim round.
    expect(announced).toEqual([]);
  });
});
