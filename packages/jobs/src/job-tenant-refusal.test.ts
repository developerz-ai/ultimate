// A job whose payload names org A is refused when it is enqueued for org B — an explicit
// `tenantId`, `handle.as(actorOfB, …)`, or an ambient actor of B — and a row already queued that
// way is refused at its run, terminally, before the body. `tenant: 'none'` is never compared.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { resetJobDriver, setJobDriver } from './driver';
import { memoryJobDriver } from './driver-memory';
import { job, resetJobs } from './job';
import { declare, runOfForeignRow } from './job-tenant-fixture';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

const codeOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'queued',
    (error: unknown) => (isUltimateError(error) ? error.code : error),
  );

const asActorOf = (orgId: string | undefined): Ctx =>
  ctxOf({
    role: 'web',
    buildId: 'test',
    actor: userActor({ id: 'u-1', ...(orgId === undefined ? {} : { orgId }) }),
  });

describe('the enqueue refuses a payload for another org', () => {
  test('an explicit tenantId, and handle.as with an actor of another org', async () => {
    setJobDriver(memoryJobDriver());
    const invite = declare();
    expect(await codeOf(invite.enqueue({ orgId: 'org-a' }, { tenantId: 'org-b' }))).toBe(
      'X_JOB_TENANT_MISMATCH',
    );
    expect(await codeOf(invite.as({ orgId: 'org-b', id: 'u-1' }, { orgId: 'org-a' }))).toBe(
      'X_JOB_TENANT_MISMATCH',
    );
    expect(await codeOf(invite.as({ orgId: 'org-a', id: 'u-1' }, { orgId: 'org-a' }))).toBe(
      'queued',
    );
  });

  test('an ambient actor of another org, on enqueue and enqueueMany alike', async () => {
    setJobDriver(memoryJobDriver());
    const invite = declare();
    await runWithContext(asActorOf('org-b'), async () => {
      expect(await codeOf(invite.enqueue({ orgId: 'org-a' }))).toBe('X_JOB_TENANT_MISMATCH');
      expect(await codeOf(invite.enqueueMany([{ orgId: 'org-a' }]))).toBe('X_JOB_TENANT_MISMATCH');
      expect(await codeOf(invite.enqueue({ orgId: 'org-b' }))).toBe('queued');
    });
    // An actor with no org — a sign-up, a script — has nothing to disagree with.
    await runWithContext(asActorOf(undefined), async () => {
      expect(await codeOf(invite.enqueue({ orgId: 'org-a' }))).toBe('queued');
    });
  });

  test("tenant: 'none' is never compared", async () => {
    setJobDriver(memoryJobDriver());
    const sweep = job<{ n: number }>({
      name: 'sweep',
      tenant: 'none',
      input: t.object({ n: t.number }),
      idempotencyKey: ({ n }) => `sweep:${n}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    await runWithContext(asActorOf('org-b'), async () => {
      expect(await codeOf(sweep.enqueue({ n: 1 }, { tenantId: 'org-b' }))).toBe('queued');
    });
  });
});

describe('the run refuses a row already queued for another org', () => {
  test('dead on its first attempt, the body never ran (memory)', async () => {
    const { outcome, error, ran } = await runOfForeignRow(memoryJobDriver());
    expect(outcome).toBe('dead-lettered');
    expect(error).toContain('X_JOB_TENANT_MISMATCH');
    expect(ran).toEqual([]);
  });
});
