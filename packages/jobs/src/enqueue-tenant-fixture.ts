// A plain `handle.enqueue(input)` of a tenant-declaring job, driven against any driver: the row is
// queued for the org its payload names, so two orgs' identical idempotency keys are two jobs and a
// per-tenant limit counts the org — `enqueue-tenant*.test.ts` holds memory and Postgres to it.

import { expect } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { JobDriver } from './driver';
import type { JobHandle } from './job';
import { job } from './job';
import { concurrencyLimiter } from './limits';
import { memoryOutboxStore, outboxJobsFacade } from './outbox';
import { jobWorker } from './worker';

interface InvoiceInput {
  readonly orgId: string;
  readonly invoiceId: string;
}

export function declareInvoice(ran: string[] = []): JobHandle<InvoiceInput> {
  return job<InvoiceInput>({
    name: 'sendInvoice',
    tenant: ({ orgId }) => orgId,
    input: t.object({ orgId: t.string, invoiceId: t.string }),
    idempotencyKey: ({ invoiceId }) => `invoice:${invoiceId}`,
    retry: { attempts: 1 },
    run: async ({ input }) => {
      ran.push(input.orgId);
    },
  });
}

const direct = (driver: JobDriver) =>
  outboxJobsFacade({ store: memoryOutboxStore(), driver }, () => undefined);

async function tenantOf(driver: JobDriver, id: string): Promise<string | undefined> {
  return (await driver.introspect?.job(id))?.tenantId;
}

/** Org B's `invoice:1` is its own job, not a dedupe onto org A's — and each row names its org. */
export async function twoOrgsOneKey(driver: JobDriver): Promise<void> {
  const invoice = declareInvoice();
  const jobs = direct(driver);
  const a = await jobs.enqueue(invoice, { orgId: 'org-a', invoiceId: '1' });
  const b = await jobs.enqueue(invoice, { orgId: 'org-b', invoiceId: '1' });
  expect(b.deduped).toBe(false);
  expect(b.id).not.toBe(a.id);
  expect(await tenantOf(driver, a.id)).toBe('org-a');
  expect(await tenantOf(driver, b.id)).toBe('org-b');
  // The SAME org's repeat still dedupes: the namespace is per tenant, not gone.
  const again = await jobs.enqueue(invoice, { orgId: 'org-a', invoiceId: '1' });
  expect(again).toMatchObject({ id: a.id, deduped: true });
}

/** The batch path answers the same: one row per org, each queued for its own. */
export async function twoOrgsOneKeyMany(driver: JobDriver): Promise<void> {
  const invoice = declareInvoice();
  const [a, b] = await direct(driver).enqueueMany(invoice, [
    { orgId: 'org-a', invoiceId: '1' },
    { orgId: 'org-b', invoiceId: '1' },
  ]);
  if (a === undefined || b === undefined) return expect.unreachable('two answers for two inputs');
  expect(b.deduped).toBe(false);
  expect(b.id).not.toBe(a.id);
  expect(await tenantOf(driver, a.id)).toBe('org-a');
  expect(await tenantOf(driver, b.id)).toBe('org-b');
}

/** `perTenant: 1` with org A's slot held: org A's plain enqueue is shed, unrun — not run as nobody's. */
export async function perTenantCountsThePayloadOrg(driver: JobDriver): Promise<readonly string[]> {
  const ran: string[] = [];
  const invoice = declareInvoice(ran);
  await direct(driver).enqueue(invoice, { orgId: 'org-a', invoiceId: '1' });
  const limiter = concurrencyLimiter({ perTenant: 1 });
  const held = limiter.tryAcquire({ queue: 'default', tenantId: 'org-a' });
  const worker = jobWorker({
    driver,
    limiter,
    concurrency: 10,
    pollIntervalMs: 0,
    context: () => ({}) as Ctx,
    drainOnShutdown: false,
  });
  try {
    await worker.tick();
    return ran;
  } finally {
    held?.release();
    await worker.stop('test-end');
  }
}
