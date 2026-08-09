/**
 * live — snapshot, incremental patch on write, policy-filtered delivery, and reconnect delta.
 * Runs against a cloned DB with an in-process replicator and an in-process NATS.
 */

import { expect, test } from '@ultimat3/testing';
import { publishPost } from './actions';
import { liveFeed } from './live';
import { likePost } from './mutator';

test('the initial snapshot is scoped to the actor’s org', async ({ seed, actorFor, subscribe }) => {
  const { ada, acme } = await seed('dev').pick({ ada: 'member:ada', acme: 'org:acme' });

  const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));

  expect(feed.rows().length).toBe(3);
  expect(feed.rows().every((row) => row.orgId === acme.id)).toBe(true);
});

test('a publish arrives as one incremental patch, not a refetch', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme, draft } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    draft: 'post:draft-money',
  });

  const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));
  const before = feed.rows().length;

  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  await feed.settled();

  expect(feed.rows().length).toBe(before);
  expect(feed.patches()).toMatchObject([{ op: 'update', row: { id: draft.id } }]);
});

test('a row that fails the policy is never delivered', async ({ seed, actorFor, subscribe }) => {
  const { mara, tinta, acme } = await seed('dev').pick({
    mara: 'member:mara',
    tinta: 'org:tinta',
    acme: 'org:acme',
  });

  const feed = await subscribe(liveFeed.as(actorFor(mara), { orgId: tinta.id }));

  expect(feed.rows().some((row) => row.orgId === acme.id)).toBe(false);
  await expect(
    subscribe(liveFeed.as(actorFor(mara), { orgId: acme.id })),
  ).rejects.toBeUltimateError('X_POLICY_DENIED');
});

test('an offline like applies locally, queues, and reconciles on reconnect', async ({
  seed,
  actorFor,
  subscribe,
  network,
}) => {
  // Ada's own org, and a post that starts at zero likes: the mutator's `orgId` is what `postLike`
  // decides on, so a post from another org would be denied rather than queued.
  const { ada, acme, post } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    post: 'post:draft-money',
  });

  const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));
  const mutate = likePost.as(actorFor(ada));

  network.offline();
  await mutate({ postId: post.id, orgId: acme.id });
  expect(feed.local(post.id)?.likeCount).toBe(1); // optimistic twin, applied immediately
  expect(mutate.queued()).toBe(1);

  network.online();
  await feed.settled();

  expect(mutate.queued()).toBe(0);
  expect(feed.row(post.id)?.likeCount).toBe(1); // server-wins, and the server agrees
});

test('reconnect inside the buffer window is a delta, not a snapshot', async ({
  seed,
  actorFor,
  subscribe,
  network,
}) => {
  const { ada, acme, draft } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    draft: 'post:draft-money',
  });

  const feed = await subscribe(liveFeed.as(actorFor(ada), { orgId: acme.id }));
  const lsn = feed.lsn();

  network.drop();
  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  network.online();
  await feed.settled();

  expect(feed.resubscribedFrom()).toBe(lsn);
  expect(feed.snapshots()).toBe(1); // the initial one only
});
