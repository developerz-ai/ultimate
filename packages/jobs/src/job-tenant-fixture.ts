// A job declaring `tenant: ({ orgId }) => orgId`, and a row queued for another org than its payload
// names, run through a real worker pass — the scenario `job-tenant-refusal*.test.ts` drives on
// every driver, so the memory, embedded Postgres and Redis drivers are held to one answer.

import { expect } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import { job } from './job';
import { jobWorker } from './worker';

export function declare(ran: string[] = []) {
  return job<{ orgId: string }>({
    name: 'sendInvite',
    tenant: ({ orgId }) => orgId,
    input: t.object({ orgId: t.string }),
    idempotencyKey: ({ orgId }) => `invite:${orgId}:${crypto.randomUUID()}`,
    retry: { attempts: 3 },
    run: async ({ input }) => {
      ran.push(input.orgId);
    },
  });
}

/** A row the enqueue no longer writes: queued for org B with a payload naming org A. */
export async function runOfForeignRow(driver: JobDriver): Promise<{
  outcome: string | undefined;
  error: string | undefined;
  ran: readonly string[];
}> {
  const ran: string[] = [];
  const invite = declare(ran);
  const { id } = await driver.enqueue({
    name: invite.name,
    queue: 'default',
    input: { orgId: 'org-a' },
    idempotencyKey: 'invite:stale',
    maxAttempts: 3,
    tenantId: 'org-b',
  });
  const worker = jobWorker({
    driver,
    context: () => ctxOf({ role: 'worker', buildId: 'test' }),
    pollIntervalMs: 0,
    drainOnShutdown: false,
  });
  try {
    const [execution] = await worker.tick();
    expect(execution?.jobId).toBe(id);
    return { outcome: execution?.outcome, error: execution?.error, ran };
  } finally {
    await worker.stop('test-end');
  }
}
