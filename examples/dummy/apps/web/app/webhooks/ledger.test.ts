/**
 * unit — `postlyWebhookLedger` over the in-memory driver: the consecutive-failure count the
 * mechanism disables on, read from the app's own `webhook_deliveries`, and a disable that keeps
 * the FIRST reason. The two facts a delivery's `disableAfter` stands on.
 */

import { afterAll, expect, test } from 'bun:test';
import { db, driver } from '@postly/db';
import { ctxOf, runWithContext, userActor } from '@ultimat3/core';
import type { WebhookAttempt } from '@ultimat3/jobs';
import { postlyWebhookLedger } from './ledger';
import { insertEndpoint } from './repo';

// Ids from this file's own range (`…b0…`): bun runs several files over one in-memory driver.
let issued = 0;
const nextId = (): string => {
  issued += 1;
  return `00000000-0000-4000-8000-b0${String(issued).padStart(10, '0')}`;
};

afterAll(() => {
  driver.reset?.();
});

/**
 * Inside the org, as a delivery runs: the handle scopes every read to the actor's org and refuses
 * one with none (`X_TENANCY_UNSCOPED`) — the ledger names no org, exactly as its seam does not.
 */
const inOrg = <T>(orgId: string, fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ role: 'worker', actor: userActor({ id: 'worker', orgId }) }), fn);

const anEndpoint = () => {
  const orgId = nextId();
  return inOrg(orgId, () =>
    insertEndpoint({ orgId, slot: '1', url: 'https://hooks.example.test/in', secret: 'whsec' }),
  );
};

const attempt = (endpointId: string, ok: boolean, at: number): WebhookAttempt => ({
  webhook: 'posts.published.webhook',
  endpointId,
  eventId: 'evt',
  topic: 'post.published',
  attempt: 1,
  ok,
  status: ok ? 200 : 503,
  at,
  durationMs: 12.6,
  ...(ok ? {} : { error: 'the receiver answered 503' }),
});

test('failures count up in a row, a success resets the count, and every attempt is a row', async () => {
  const endpoint = await anEndpoint();
  await inOrg(endpoint.orgId, async () => {
    const counts = [];
    counts.push(await postlyWebhookLedger.record(attempt(endpoint.id, false, 1_000)));
    counts.push(await postlyWebhookLedger.record(attempt(endpoint.id, false, 2_000)));
    counts.push(await postlyWebhookLedger.record(attempt(endpoint.id, true, 3_000)));
    counts.push(await postlyWebhookLedger.record(attempt(endpoint.id, false, 4_000)));

    expect(counts).toEqual([1, 2, 0, 1]);
    const rows = await db.webhookDeliveries.where({ endpointId: endpoint.id }).all();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.orgId === endpoint.orgId)).toBe(true);
  });
});

test('one endpoint’s failures are not another’s', async () => {
  const failing = await anEndpoint();
  await inOrg(failing.orgId, async () => {
    await postlyWebhookLedger.record(attempt(failing.id, false, 1_000));
    await postlyWebhookLedger.record(attempt(failing.id, false, 2_000));
  });
  const healthy = await anEndpoint();
  await inOrg(healthy.orgId, async () => {
    expect(await postlyWebhookLedger.record(attempt(healthy.id, false, 3_000))).toBe(1);
  });
});

test('disable switches the endpoint off once, and keeps the reason that did it', async () => {
  const endpoint = await anEndpoint();
  await inOrg(endpoint.orgId, async () => {
    expect(await postlyWebhookLedger.isDisabled(endpoint.id)).toBe(false);

    await postlyWebhookLedger.disable(endpoint.id, '10 consecutive failed deliveries');
    await postlyWebhookLedger.disable(endpoint.id, 'a late attempt repeating the verdict');

    expect(await postlyWebhookLedger.isDisabled(endpoint.id)).toBe(true);
    const row = await db.webhookEndpoints.where({ id: endpoint.id }).one();
    expect(row?.disabledReason).toBe('10 consecutive failed deliveries');
  });
});

test('an attempt that loses its number to a concurrent one re-reads, and counts from that row', async () => {
  const endpoint = await anEndpoint();
  await inOrg(endpoint.orgId, async () => {
    // The race, made deterministic: between this attempt's read of the history (empty) and its
    // write, a concurrent failed delivery to the same endpoint lands as row 1.
    const handle = db.webhookDeliveries;
    const insert = handle.insert;
    let raced = false;
    handle.insert = async (row, options) => {
      if (!raced) {
        raced = true;
        await insert({ ...row, eventId: 'evt-concurrent', consecutiveFailures: 1 }, options);
      }
      return insert(row, options);
    };
    try {
      // Counted from the row that beat it — 2 — never from the stale read, which said 1.
      expect(await postlyWebhookLedger.record(attempt(endpoint.id, false, 1_000))).toBe(2);
    } finally {
      handle.insert = insert;
    }
    const rows = await db.webhookDeliveries.where({ endpointId: endpoint.id }).all();
    expect(rows.map((row) => [row.seq, row.consecutiveFailures]).sort()).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});
