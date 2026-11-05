/**
 * contract — `publishPost` behind the `/v1` bearer mount, at its own pinned template: one
 * declaration, no route file. The mount is the app's own (`defineApi({ http: { mounts } })`),
 * built by the function both boots build it with; registration is the preload's.
 */

import { apiMountRoutes } from '@ultimat3/cli';
import { frozenClock } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { expect, test } from '@ultimat3/testing';
import { issueOrgKeyFor } from '../../runs/keys';
import { notifySubscribers } from '../jobs/notify-subscribers';
import { postById } from '../queries/post-by-id';

const clock = frozenClock('2026-10-01T09:00:00.000Z');

const mountedServer = () =>
  httpServer({
    routes: apiMountRoutes(),
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

/** The concrete URL, written out: the test is the template's caller, not its author. */
const publish = (postId: string, body: unknown, token: string): Request =>
  new Request(`http://dev.test/v1/posts/${postId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

interface Answer {
  readonly id: string;
  readonly status: string;
  readonly code?: string;
}

test('a key scoped post:publish publishes its org’s draft at /v1/posts/:postId/publish', async ({
  seed,
  runJobs,
}) => {
  const { draft } = await seed('dev').pick({ draft: 'post:draft-money' });
  const issued = await issueOrgKeyFor({ orgId: draft.orgId, clock });

  const response = await mountedServer().fetch(
    publish(draft.id, { orgId: draft.orgId }, issued.key),
  );

  expect(response.status).toBe(200);
  const answer = (await response.json()) as Answer;
  expect(answer.id).toBe(draft.id);
  expect(answer.status).toBe('published');
  // The handler ran whole, in its transaction: the subscriber fanout is on the queue.
  expect(await runJobs.depth(notifySubscribers)).toBe(1);
});

test('a key without post:publish finds no route there: 404, and the draft stays a draft', async ({
  seed,
  actorFor,
}) => {
  const { draft, author } = await seed('dev').pick({
    draft: 'post:draft-money',
    author: 'member:bruno',
  });
  const issued = await issueOrgKeyFor({ orgId: draft.orgId, clock, scopes: ['run:write'] });

  const response = await mountedServer().fetch(
    publish(draft.id, { orgId: draft.orgId }, issued.key),
  );

  expect(response.status).toBe(404);
  const [after] = await postById.as(actorFor(author), { postId: draft.id, orgId: draft.orgId });
  expect(after?.status).toBe('draft');
});

test('another org’s key cannot publish this org’s post, by either org in the body', async ({
  seed,
  actorFor,
}) => {
  const { draft, author, foreign } = await seed('dev').pick({
    draft: 'post:draft-money', // Acme's
    author: 'member:bruno',
    foreign: 'org:tinta',
  });
  const theirs = await issueOrgKeyFor({ orgId: foreign.id, clock });
  const server = mountedServer();

  // Naming the post's org: the rule's tenancy line refuses before any read.
  const named = await server.fetch(publish(draft.id, { orgId: draft.orgId }, theirs.key));
  expect(named.status).toBe(403);
  expect(((await named.json()) as Answer).code).toBe('X_FORBIDDEN');

  // Naming its own org: the row loader reads inside Tinta, finds nothing, and `null` denies.
  const own = await server.fetch(publish(draft.id, { orgId: foreign.id }, theirs.key));
  expect(own.status).toBe(403);
  expect(((await own.json()) as Answer).code).toBe('X_FORBIDDEN');

  const [after] = await postById.as(actorFor(author), { postId: draft.id, orgId: draft.orgId });
  expect(after?.status).toBe('draft');
});
