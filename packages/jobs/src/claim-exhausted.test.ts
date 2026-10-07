// `announceExhausted`: what the claim round does with the rows a pass buried. The driver half —
// that a row is buried once, on both drivers — is `driver-lifecycle-fixture.ts`.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, logger } from '@ultimat3/core';
import type { StandardSchemaV1 } from '@ultimat3/schema';
import { announceExhausted } from './claim-exhausted';
import type { JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import { job, resetJobs } from './job';
import type { JobSettled } from './settled';
import { ON_SETTLED_ATTEMPTS } from './settled';

interface OrgInput {
  readonly orgId: string;
}

const passthrough: StandardSchemaV1<unknown, OrgInput> = {
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => ({ value: value as OrgInput }),
  },
};

const context = (): Ctx => ctxOf({ role: 'worker', buildId: 'test' });

const buried = (name: string, id: string): JobRecord => ({
  id,
  name,
  queue: 'default',
  input: { orgId: 'org-7' },
  idempotencyKey: `k:${id}`,
  runId: `run-${id}`,
  attempt: 3,
  maxAttempts: 3,
  state: 'dead',
  runAt: 0,
  createdAt: 0,
  updatedAt: 0,
  lastError: LEASE_LAPSED_FINAL_ATTEMPT,
});

afterEach(() => {
  resetJobs();
});

describe('announceExhausted', () => {
  test('each buried row is logged and its job told once, in the job own tenant scope', async () => {
    const log = spyOn(logger, 'error').mockImplementation(() => undefined);
    const endings: { readonly settled: JobSettled<OrgInput>; readonly org: string | undefined }[] =
      [];
    job<OrgInput>({
      name: 'syncOrg',
      tenant: ({ orgId }) => orgId,
      input: passthrough,
      idempotencyKey: ({ orgId }) => `sync:${orgId}`,
      retry: { attempts: 3 },
      run: () => Promise.resolve(),
      onSettled: (settled) => {
        endings.push({ settled, org: settled.ctx.actor.orgId });
        return Promise.resolve();
      },
    });
    try {
      const count = await announceExhausted({
        exhausted: [buried('syncOrg', 'a'), buried('syncOrg', 'b')],
        workerId: 'w1',
        context,
      });
      expect(count).toEqual({ deadLettered: 2, dropped: 0 });
      expect(endings.map((ending) => ending.settled.jobId)).toEqual(['a', 'b']);
      expect(endings[0]?.settled).toMatchObject({
        outcome: 'dead-lettered',
        attempt: 3,
        runId: 'run-a',
        input: { orgId: 'org-7' },
        error: LEASE_LAPSED_FINAL_ATTEMPT,
        code: undefined,
      });
      // The body never ran here, so the scope is derived as a refused run's is: from the payload.
      expect(endings[0]?.org).toBe('org-7');
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        'jobs.claim.exhausted',
        'jobs.claim.exhausted',
      ]);
      expect(log.mock.calls[0]?.[1]).toMatchObject({
        workerId: 'w1',
        job: 'syncOrg',
        jobId: 'a',
        attempt: 3,
        maxAttempts: 3,
      });
    } finally {
      log.mockRestore();
    }
  });

  test('a row of a job this build does not register is logged and skipped, never thrown', async () => {
    const log = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      expect(
        await announceExhausted({ exhausted: [buried('goneJob', 'a')], workerId: 'w1', context }),
      ).toEqual({ deadLettered: 1, dropped: 0 });
      expect(log.mock.calls.map((call) => call[0])).toEqual(['jobs.claim.exhausted']);
    } finally {
      log.mockRestore();
    }
  });

  test('a hook that keeps throwing gets its tries and never rejects the claim round', async () => {
    const log = spyOn(logger, 'error').mockImplementation(() => undefined);
    let tries = 0;
    job<OrgInput>({
      name: 'brokenHook',
      tenant: 'none',
      input: passthrough,
      idempotencyKey: ({ orgId }) => `broken:${orgId}`,
      retry: { attempts: 3 },
      run: () => Promise.resolve(),
      onSettled: () => {
        tries += 1;
        return Promise.reject(new TypeError('the status table is gone'));
      },
    });
    try {
      expect(
        await announceExhausted({
          exhausted: [buried('brokenHook', 'a')],
          workerId: 'w1',
          context,
        }),
      ).toEqual({ deadLettered: 1, dropped: 0 });
      expect(tries).toBe(ON_SETTLED_ATTEMPTS);
      expect(log.mock.calls.map((call) => call[0])).toEqual([
        'jobs.claim.exhausted',
        'jobs.on-settled.failed',
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('nothing buried is nothing said', async () => {
    const log = spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      expect(await announceExhausted({ exhausted: [], workerId: 'w1', context })).toEqual({
        deadLettered: 0,
        dropped: 0,
      });
      expect(log.mock.calls).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});
