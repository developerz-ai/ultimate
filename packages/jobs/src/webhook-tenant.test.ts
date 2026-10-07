// A delivery to an endpoint an org owns runs under that org. The delivery input carried only
// `endpointId` and `eventId`, and `tenant` is a synchronous function of the input — so the
// `tenant: ({ endpointId }) => …` every doc suggested could not be written, and a multi-tenant app's
// endpoint read ran under no org at all. The org now rides on the input, beside the two ids.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { type JobHandle, resetJobs } from './job';
import { type OrgWebhookDeliveryInput, type WebhookDeliveryInput, webhook } from './webhook';
import { ENDPOINT, PUBLIC_IP } from './webhook-harness-fixture';
import { memoryWebhookLedger } from './webhook-ledger';

beforeEach(() => {
  resetJobs();
});

/** The org every seam read under, in order. */
let seen: (string | undefined)[] = [];

const orgDelivery = (): JobHandle<OrgWebhookDeliveryInput> =>
  webhook({
    name: 'org-hooks',
    tenant: ({ orgId }) => orgId,
    ledger: memoryWebhookLedger(),
    resolve: () => Promise.resolve([PUBLIC_IP]),
    // Both the org the seam is HANDED (the input's) and the one the run's actor carries: they are
    // one org, and the seam never has to read the actor to learn it.
    endpoint: ({ orgId, ctx }) => {
      seen.push(orgId, ctx.actor.orgId);
      return ENDPOINT;
    },
    event: ({ orgId, ctx }) => {
      seen.push(orgId, ctx.actor.orgId);
      return { topic: 'post.published', body: '{}' };
    },
    fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
  });

/** Queued on a memory driver and run by the real `executeJob`, under the production worker. */
async function deliver(handle: JobHandle<WebhookDeliveryInput>, input: WebhookDeliveryInput) {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input,
    idempotencyKey: handle.idempotencyKeyFor(input),
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [handle.queue],
    limit: 1,
    visibilityTimeoutMs: 30_000,
    workerId: 'worker-test',
  });
  return executeJob({
    driver,
    claimed: claimed as ClaimedJob,
    handle,
    ctx: ctxOf({ role: 'worker' }),
  });
}

describe('webhook() — the org that owns the endpoint is on the delivery', () => {
  test('the org survives the parse, and the key still names the endpoint and the event', () => {
    const handle = orgDelivery();
    const input = { endpointId: 'ep_1', eventId: 'evt_1', orgId: 'org-1' };
    expect(handle.parse(input)).toEqual(input);
    expect(handle.tenantFor(input)).toBe('org-1');
    expect(handle.idempotencyKeyFor(input)).toBe('org-hooks:ep_1:evt_1');
  });

  test('the endpoint and the event are read under the org the delivery names', async () => {
    seen = [];
    const execution = await deliver(orgDelivery(), {
      endpointId: 'ep_1',
      eventId: 'evt_1',
      orgId: 'org-1',
    });
    expect(execution.outcome).toBe('completed');
    expect(seen).toEqual(['org-1', 'org-1', 'org-1', 'org-1']);
  });

  test('an org-owned delivery enqueued without its org fails, naming the enqueue to fix', async () => {
    seen = [];
    const execution = await deliver(orgDelivery(), { endpointId: 'ep_1', eventId: 'evt_1' });
    expect(execution.outcome).not.toBe('completed');
    expect(execution.error).toContain('enqueued with no orgId');
    // Refused before any seam ran: nothing was read under no org.
    expect(seen).toEqual([]);
  });

  test("tenant: 'none' still takes the two ids alone", () => {
    const handle = webhook({
      name: 'global-hooks',
      tenant: 'none',
      ledger: memoryWebhookLedger(),
      endpoint: () => ENDPOINT,
      event: () => ({ topic: 'post.published', body: '{}' }),
    });
    expect(handle.parse({ endpointId: 'ep_1', eventId: 'evt_1' })).toEqual({
      endpointId: 'ep_1',
      eventId: 'evt_1',
    });
    expect(handle.tenantFor({ endpointId: 'ep_1', eventId: 'evt_1' })).toBeUndefined();
  });
});
