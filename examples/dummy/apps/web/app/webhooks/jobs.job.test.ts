/**
 * job — `postPublishedWebhook`, from the publish that announces it to the ledger row its attempt
 * leaves, through the real queue `runJobs` installs and drained by the PRODUCTION worker (no
 * actor). What can fail: the fan-out (one delivery per live endpoint of the publishing org, none
 * for another org's), the org on the delivery (the endpoint and the post are read under it), and
 * the attempt landing on Postly's own ledger.
 *
 * The receiver is under `.invalid`, a name that never resolves (RFC 6761): the network is sealed in
 * tests, and an unresolved host is the mechanism's TRANSIENT failure — recorded, then retried.
 */

import { db } from '@postly/db';
import { hmac } from '@ultimat3/core';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { expect, jobTest } from '@ultimat3/testing';
import { publishPost } from '../posts/actions/publish-post';
import { addWebhookEndpoint } from './actions/add-webhook-endpoint';
import {
  BILLING_EVENTS_PATH,
  BILLING_SIGNATURE_HEADER,
  billingEventsReceiver,
} from './jobs/billing-events-receiver';
import { POST_PUBLISHED, postPublishedWebhook } from './jobs/post-published-webhook';

const RECEIVER = 'https://hooks.postly.invalid/inbox';

jobTest(
  'a publish is one delivery per live endpoint of its org, read under that org and kept on the ledger',
  async ({ seed, actorFor, runJobs }) => {
    const { draft, ada, mara } = await seed('dev').pick({
      draft: 'post:draft-money', // Acme's
      ada: 'member:ada', // Acme's owner
      mara: 'member:mara', // Tinta's owner
    });

    const issued = await addWebhookEndpoint.as(actorFor(ada), { orgId: ada.orgId, url: RECEIVER });
    // Another org's receiver: Acme's publication is none of its business.
    await addWebhookEndpoint.as(actorFor(mara), { orgId: mara.orgId, url: RECEIVER });
    expect(issued.secret).toMatch(/^[0-9a-f]{64}$/);

    await publishPost.as(actorFor(ada), { postId: draft.id, orgId: draft.orgId, notify: false });
    expect(await runJobs.depth(postPublishedWebhook)).toBe(1);

    const trace = await runJobs.drain();
    // Unresolved is transient: the run is retried, not finished.
    expect(trace.executions.map((execution) => execution.outcome)).not.toContain('completed');

    const rows = await db.webhookDeliveries
      .where({ orgId: ada.orgId, endpointId: issued.id })
      .all();
    expect(rows.map((row) => [row.topic, row.eventId, row.ok, row.consecutiveFailures])).toEqual([
      [POST_PUBLISHED, draft.id, false, 1],
    ]);
  },
);

jobTest('a disabled endpoint is not announced to', async ({ seed, actorFor, runJobs }) => {
  const { draft, ada } = await seed('dev').pick({
    draft: 'post:draft-money',
    ada: 'member:ada',
  });
  const issued = await addWebhookEndpoint.as(actorFor(ada), { orgId: ada.orgId, url: RECEIVER });
  await db.webhookEndpoints.updateWhere(
    { id: issued.id, orgId: ada.orgId },
    { disabledReason: '10 consecutive failed deliveries' },
    { orgId: ada.orgId },
  );

  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: draft.orgId, notify: false });

  expect(await runJobs.depth(postPublishedWebhook)).toBe(0);
});

jobTest('only the org’s owner registers a receiver', async ({ seed, actorFor }) => {
  const { bruno } = await seed('dev').pick({ bruno: 'member:bruno' });
  await expect(
    addWebhookEndpoint.as(actorFor(bruno), { orgId: bruno.orgId, url: RECEIVER }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

/**
 * The inbound half: the billing vendor's event through the real pipeline, verified over its exact
 * bytes, queued, acknowledged, and parsed by `handle` in the worker. No content type, as vendors
 * send it. The event id is read from the SIGNED body, never a header: one captured signature
 * replayed under fresh ids is still one row.
 */
const BILLING_SECRET = 'whsec_billing_test';

const withBillingSecret = async (run: () => Promise<void>): Promise<void> => {
  const before = Bun.env['BILLING_WEBHOOK_SECRET'];
  Bun.env['BILLING_WEBHOOK_SECRET'] = `${BILLING_SECRET},whsec_retired`;
  try {
    await run();
  } finally {
    if (before === undefined) delete Bun.env['BILLING_WEBHOOK_SECRET'];
    else Bun.env['BILLING_WEBHOOK_SECRET'] = before;
  }
};

const billingPipeline = () =>
  httpPipeline({
    table: httpRouter(billingEventsReceiver.routes()),
    config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
  });

const signBilling = (body: string): string =>
  `sha256=${hmac('sha256', BILLING_SECRET, body, 'hex')}`;

const deliverBilling = (
  pipeline: ReturnType<typeof billingPipeline>,
  body: string,
  signature: string,
  headerId = 'evt_header',
) =>
  pipeline.handle(
    new Request(`http://localhost${BILLING_EVENTS_PATH}`, {
      method: 'POST',
      headers: { [BILLING_SIGNATURE_HEADER]: signature, 'x-billing-event-id': headerId },
      body,
    }),
    { role: 'web' },
  );

jobTest('a signed billing event is queued, acknowledged and handled once', ({ runJobs }) =>
  withBillingSecret(async () => {
    const pipeline = billingPipeline();
    const body = '{"id":"evt_42","type":"invoice.paid","invoice":"in_42"}';
    const signed = signBilling(body);

    expect((await deliverBilling(pipeline, body, 'sha256=forged')).status).toBe(401);
    expect(await (await deliverBilling(pipeline, body, signed)).json()).toEqual({
      ok: true,
      eventId: 'evt_42',
      deduped: false,
    });
    expect(await runJobs.depth(billingEventsReceiver)).toBe(1);

    const trace = await runJobs.drain();
    expect(trace.executions.map((run) => [run.outcome, run.result])).toEqual([
      ['completed', { eventId: 'evt_42', type: 'invoice.paid', invoice: 'in_42' }],
    ]);
  }),
);

jobTest('one captured signature replayed under fresh header ids is still one row', ({ runJobs }) =>
  withBillingSecret(async () => {
    const pipeline = billingPipeline();
    const body = '{"id":"evt_7","type":"invoice.paid","invoice":"in_7"}';
    const signed = signBilling(body);
    const answers = [];
    for (const headerId of ['evt_a', 'evt_b', 'evt_c']) {
      answers.push(await (await deliverBilling(pipeline, body, signed, headerId)).json());
    }
    // The header the attacker controls is not read: the id is the signed body's.
    expect(answers.map((answer) => [answer.eventId, answer.deduped])).toEqual([
      ['evt_7', false],
      ['evt_7', true],
      ['evt_7', true],
    ]);
    expect(await runJobs.depth(billingEventsReceiver)).toBe(1);
  }),
);

jobTest('a signed body Postly cannot read is refused naming none of it', ({ runJobs }) =>
  withBillingSecret(async () => {
    const pipeline = billingPipeline();
    const body = '{"id":"evt_9","card":"4111111111111111"';
    const response = await deliverBilling(pipeline, body, signBilling(body));
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(JSON.parse(text).code).toBe('X_BILLING_EVENT_UNREADABLE');
    expect(text).not.toContain('4111');
    expect(await runJobs.depth(billingEventsReceiver)).toBe(0);
  }),
);
