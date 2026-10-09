/**
 * unit — registering and revoking an org's webhook receivers, through the actions an owner calls.
 * What can fail: a URL the delivery screen would refuse forever getting registered, the per-org
 * cap breaking under concurrent adds (the database holds it, not a count), and a leaked secret
 * having no way out.
 */

import { db } from '@postly/db';
import { expect, test } from '@ultimat3/testing';
import { addWebhookEndpoint } from './actions/add-webhook-endpoint';
import { removeWebhookEndpoint } from './actions/remove-webhook-endpoint';
import { ENDPOINTS_PER_ORG } from './entity';

const receiver = (n: number): string => `https://hooks.example.com/postly/${n}`;

test('a receiver inside a network, or on this machine, is refused when it is registered', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const add = (url: string) => addWebhookEndpoint.as(actorFor(ada), { orgId: ada.orgId, url });

  for (const url of [
    'http://169.254.169.254/latest/meta-data/', // the cloud metadata service
    'https://10.0.0.7/hooks',
    'https://[::1]/hooks',
    'https://localhost/hooks',
  ]) {
    await expect(add(url)).rejects.toBeUltimateError('X_ORG_ENDPOINT_URL_REFUSED');
  }
  expect(await db.webhookEndpoints.where({ orgId: ada.orgId }).count()).toBe(0);
});

test('the per-org cap holds when every add races: the database takes exactly the cap', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const actor = actorFor(ada);

  const settled = await Promise.allSettled(
    Array.from({ length: ENDPOINTS_PER_ORG + 3 }, (_, n) =>
      addWebhookEndpoint.as(actor, { orgId: ada.orgId, url: receiver(n) }),
    ),
  );

  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(ENDPOINTS_PER_ORG);
  // The rest are told the cap, never the index's raw 23505.
  for (const result of settled) {
    if (result.status === 'rejected')
      expect(result.reason).toBeUltimateError('X_ORG_ENDPOINT_LIMIT');
  }
  expect(await db.webhookEndpoints.where({ orgId: ada.orgId }).count()).toBe(ENDPOINTS_PER_ORG);
  await expect(
    addWebhookEndpoint.as(actor, { orgId: ada.orgId, url: receiver(99) }),
  ).rejects.toBeUltimateError('X_ORG_ENDPOINT_LIMIT');
});

test('an owner revokes a receiver — its secret is gone and its slot is free again', async ({
  seed,
  actorFor,
}) => {
  const { ada, bruno, mara } = await seed('dev').pick({
    ada: 'member:ada', // Acme's owner
    bruno: 'member:bruno', // Acme's author
    mara: 'member:mara', // Tinta's owner
  });
  const issued = await addWebhookEndpoint.as(actorFor(ada), {
    orgId: ada.orgId,
    url: receiver(1),
  });
  const target = { orgId: ada.orgId, endpointId: issued.id };

  // The same right that registers one: an author may not drop the org's integrations.
  await expect(removeWebhookEndpoint.as(actorFor(bruno), target)).rejects.toBeUltimateError(
    'X_FORBIDDEN',
  );
  // Another org's owner names it in their own org, where it does not exist.
  await expect(
    removeWebhookEndpoint.as(actorFor(mara), { orgId: mara.orgId, endpointId: issued.id }),
  ).rejects.toBeUltimateError('X_ORG_ENDPOINT_NOT_FOUND');

  expect(await removeWebhookEndpoint.as(actorFor(ada), target)).toEqual({ endpointId: issued.id });
  expect(await db.webhookEndpoints.where({ orgId: ada.orgId, id: issued.id }).one()).toBeNull();
  await expect(removeWebhookEndpoint.as(actorFor(ada), target)).rejects.toBeUltimateError(
    'X_ORG_ENDPOINT_NOT_FOUND',
  );
});
