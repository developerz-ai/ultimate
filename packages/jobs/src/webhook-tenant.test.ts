// A delivery to an endpoint an org owns runs under that org. `tenant` is a synchronous function of
// the input, so the org rides on it beside the two ids — `tenant: ({ orgId }) => orgId`. A 25.0.0
// declaration that derives its org some other way (`({ endpointId }) => …`) keeps working without
// one, and a delivery whose declared tenant names no org, or whose `orgId` is not the org it runs
// under, is refused TERMINALLY: the same payload is refused identically on every attempt.

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf } from '@ultimat3/core';
import type { ClaimedJob } from './driver';
import { memoryJobDriver } from './driver-memory';
import { executeJob } from './execute';
import { type JobHandle, resetJobs } from './job';
import { type WebhookDeliveryInput, webhook } from './webhook';
import { ENDPOINT, PUBLIC_IP } from './webhook-harness-fixture';
import { memoryWebhookLedger } from './webhook-ledger';

beforeEach(() => {
  resetJobs();
});

/** The org every seam read under, in order. */
let seen: (string | undefined)[] = [];

const orgDelivery = (): JobHandle<WebhookDeliveryInput> =>
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
async function deliver(
  handle: JobHandle<WebhookDeliveryInput>,
  input: WebhookDeliveryInput,
  maxAttempts = 3,
) {
  const driver = memoryJobDriver();
  await driver.enqueue({
    name: handle.name,
    queue: handle.queue,
    input,
    idempotencyKey: handle.idempotencyKeyFor(input),
    maxAttempts,
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
    expect(execution.error).toContain('X_JOB_TENANT_MISMATCH');
    // TERMINAL: dead-lettered on attempt 1 of 3 — the payload names no org on every attempt, and
    // an unclassified refusal spent the whole policy proving it, then failed `x jobs retry` too.
    expect(execution.outcome).toBe('dead-lettered');
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

describe('webhook() — the org on the input is the org the run is under, or nothing', () => {
  test('a 25.0.0 tenant that derives its org without `orgId` still delivers, and enqueues without one', async () => {
    seen = [];
    const handle = webhook({
      name: 'derived-hooks',
      // The 25.0.0 shape: an org the app can name from the endpoint id alone.
      tenant: ({ endpointId }) => (endpointId === 'ep_1' ? 'org-1' : 'org-unknown'),
      ledger: memoryWebhookLedger(),
      resolve: () => Promise.resolve([PUBLIC_IP]),
      endpoint: ({ ctx }) => {
        seen.push(ctx.actor.orgId);
        return ENDPOINT;
      },
      event: () => ({ topic: 'post.published', body: '{}' }),
      fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
    });
    // No `orgId` at the enqueue, and that compiles: the declaration never asked for one.
    const execution = await deliver(handle, { endpointId: 'ep_1', eventId: 'evt_1' });
    expect(execution.outcome).toBe('completed');
    expect(seen).toEqual(['org-1']);
  });

  test('an orgId that is not the org the run is under is refused before either seam reads', async () => {
    seen = [];
    const handle = webhook({
      name: 'mismatched-hooks',
      tenant: () => 'org-1',
      ledger: memoryWebhookLedger(),
      resolve: () => Promise.resolve([PUBLIC_IP]),
      endpoint: ({ orgId }) => {
        seen.push(orgId);
        return ENDPOINT;
      },
      event: () => ({ topic: 'post.published', body: '{}' }),
      fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
    });
    const execution = await deliver(handle, {
      endpointId: 'ep_1',
      eventId: 'evt_1',
      orgId: 'org-2',
    });
    expect(execution.error).toContain('X_JOB_TENANT_MISMATCH');
    expect(execution.outcome).toBe('dead-lettered');
    // A seam handed `org-2` while the run is `org-1` could read another org's secret.
    expect(seen).toEqual([]);
  });

  test("tenant: 'none' with an orgId is refused too: nothing would check the org a seam is handed", async () => {
    seen = [];
    const handle = webhook({
      name: 'untenanted-hooks',
      tenant: 'none',
      ledger: memoryWebhookLedger(),
      resolve: () => Promise.resolve([PUBLIC_IP]),
      endpoint: ({ orgId }) => {
        seen.push(orgId);
        return ENDPOINT;
      },
      event: () => ({ topic: 'post.published', body: '{}' }),
      fetch: () => Promise.resolve(new Response('ok', { status: 200 })),
    });
    const execution = await deliver(handle, {
      endpointId: 'ep_1',
      eventId: 'evt_1',
      orgId: 'org-2',
    });
    expect(execution.error).toContain('X_JOB_TENANT_MISMATCH');
    expect(execution.outcome).toBe('dead-lettered');
    expect(seen).toEqual([]);
  });
});
