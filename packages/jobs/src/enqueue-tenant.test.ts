// A plain enqueue of a tenant-declaring job is queued for the org its payload names, on the memory
// driver and in the outbox row a staged enqueue writes. It used to carry no tenant: org B's
// `invoice:1` deduped onto org A's job, and `perTenant` counted every plain enqueue as nobody's.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Tx } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { memoryJobDriver } from './driver-memory';
import {
  declareInvoice,
  perTenantCountsThePayloadOrg,
  twoOrgsOneKey,
  twoOrgsOneKeyMany,
} from './enqueue-tenant-fixture';
import { job, resetJobs } from './job';
import { memoryOutboxStore, outboxJobsFacade, resetJobsFacade } from './outbox';

afterEach(() => {
  resetJobs();
  resetJobsFacade();
});

const fakeTx = (): Tx => ({ id: 'tx-1' }) as unknown as Tx;

describe('a plain enqueue is queued for the org its payload names (memory)', () => {
  test('two orgs, one idempotency key: two jobs', () => twoOrgsOneKey(memoryJobDriver()));

  test('enqueueMany: two orgs, one key, two jobs', () => twoOrgsOneKeyMany(memoryJobDriver()));

  test('perTenant counts the payload org', async () => {
    expect(await perTenantCountsThePayloadOrg(memoryJobDriver())).toEqual([]);
  });

  test('a staged enqueue writes the org into the outbox row, single and batch', async () => {
    const invoice = declareInvoice();
    const store = memoryOutboxStore();
    const tx = fakeTx();
    const jobs = outboxJobsFacade({ store, driver: memoryJobDriver() }, () => tx);
    await jobs.enqueue(invoice, { orgId: 'org-a', invoiceId: '1' });
    await jobs.enqueueMany(invoice, [{ orgId: 'org-b', invoiceId: '2' }]);
    const staged = await store.commit(tx);
    expect(staged.map((record) => record.tenantId)).toEqual(['org-a', 'org-b']);
  });

  test("tenant: 'none' still queues for no org", async () => {
    const driver = memoryJobDriver();
    const ping = job<{ n: number }>({
      name: 'ping',
      tenant: 'none',
      input: t.object({ n: t.number }),
      idempotencyKey: ({ n }) => `ping:${n}`,
      retry: { attempts: 1 },
      run: () => Promise.resolve(),
    });
    const { id } = await outboxJobsFacade(
      { store: memoryOutboxStore(), driver },
      () => undefined,
    ).enqueue(ping, { n: 1 });
    expect((await driver.introspect?.job(id))?.tenantId).toBeUndefined();
  });
});
