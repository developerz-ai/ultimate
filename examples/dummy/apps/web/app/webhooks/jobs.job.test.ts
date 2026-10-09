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
import { expect, jobTest } from '@ultimat3/testing';
import { publishPost } from '../posts/actions/publish-post';
import { addWebhookEndpoint } from './actions/add-webhook-endpoint';
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
