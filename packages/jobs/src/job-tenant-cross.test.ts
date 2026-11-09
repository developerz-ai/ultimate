// The one escape from the enqueue's tenant check: an actor of org A enqueuing work whose payload
// names org B is admitted inside a PROVEN `crossTenant(reason, fn)` — entity's mechanism, read
// through entity's own write guard — and refused everywhere else. The run's half reads no proof.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import {
  ctxOf,
  isUltimateError,
  runWithContext,
  userActor,
  withChildContext,
} from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';
import { installJobDriver, resetJobDriver } from './adapter';
import { memoryJobDriver } from './driver-memory';
import { resetJobs } from './job';
import { declare, runOfForeignRow } from './job-tenant-fixture';
import { jobWorker } from './worker';

afterEach(() => {
  resetJobDriver();
  resetJobs();
});

const codeOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => 'queued',
    (error: unknown) => (isUltimateError(error) ? error.code : error),
  );

const actorOfA = (scopes: readonly string[]): Ctx =>
  ctxOf({
    role: 'web',
    buildId: 'test',
    actor: userActor({ id: 'u-1', orgId: 'org-a', scopes }),
  });

const REASON = 'a member of org-a just created org-b and onboards it';

describe('the enqueue admits another org only inside a proven crossTenant()', () => {
  test('refused outside the scope, even for an actor that holds tenancy:cross', async () => {
    installJobDriver(memoryJobDriver());
    const invite = declare();
    await runWithContext(actorOfA([CROSS_TENANT_SCOPE]), async () => {
      expect(await codeOf(invite.enqueue({ orgId: 'org-b' }))).toBe('X_JOB_TENANT_MISMATCH');
      expect(await codeOf(invite.enqueueMany([{ orgId: 'org-b' }]))).toBe('X_JOB_TENANT_MISMATCH');
    });
  });

  test('admitted inside it, and the run then acts for the org the payload names', async () => {
    const driver = memoryJobDriver();
    installJobDriver(driver);
    const ran: string[] = [];
    const invite = declare(ran);
    await runWithContext(actorOfA([CROSS_TENANT_SCOPE]), () =>
      crossTenant(REASON, async () => {
        expect(await codeOf(invite.enqueue({ orgId: 'org-b' }))).toBe('queued');
        expect(await codeOf(invite.enqueueMany([{ orgId: 'org-b' }]))).toBe('queued');
      }),
    );
    const worker = jobWorker({
      driver,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      pollIntervalMs: 0,
      drainOnShutdown: false,
    });
    try {
      const executions = await worker.tick();
      expect(executions.map((execution) => execution.outcome)).toEqual(['completed', 'completed']);
    } finally {
      await worker.stop('test-end');
    }
    expect(ran).toEqual(['org-b', 'org-b']);
  });

  test('an explicit tenantId that contradicts the payload is refused even inside it', async () => {
    installJobDriver(memoryJobDriver());
    const invite = declare();
    await runWithContext(actorOfA([CROSS_TENANT_SCOPE]), () =>
      crossTenant(REASON, async () => {
        // The row would be queued for org-a and refused at its run: no proof makes it coherent.
        expect(await codeOf(invite.enqueue({ orgId: 'org-b' }, { tenantId: 'org-a' }))).toBe(
          'X_JOB_TENANT_MISMATCH',
        );
      }),
    );
  });

  test('re-proved at the enqueue: an actor swapped in without the scope is denied', async () => {
    installJobDriver(memoryJobDriver());
    const invite = declare();
    await runWithContext(actorOfA([CROSS_TENANT_SCOPE]), () =>
      crossTenant(REASON, () =>
        withChildContext({ actor: userActor({ id: 'u-2', orgId: 'org-a' }) }, async () => {
          expect(await codeOf(invite.enqueue({ orgId: 'org-b' }))).toBe('X_TENANCY_CROSS_DENIED');
        }),
      ),
    );
  });
});

describe('the run reads no proof', () => {
  test('a row queued for another org dies even when the worker pass runs inside crossTenant', async () => {
    const { outcome, error, ran } = await runWithContext(actorOfA([CROSS_TENANT_SCOPE]), () =>
      crossTenant(REASON, () => runOfForeignRow(memoryJobDriver())),
    );
    expect(outcome).toBe('dead-lettered');
    expect(error).toContain('X_JOB_TENANT_MISMATCH');
    expect(ran).toEqual([]);
  });
});
