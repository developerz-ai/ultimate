/**
 * live — snapshot, incremental patch on write, policy-filtered delivery, and reconnect.
 *
 * Runs against a whole `sync` node in this process: the real `LiveQueryRegistry`, the real bridge
 * from `query({ live: true })`, the real per-subscriber policy gate and the real cursor, fed by a
 * replicator over `@ultimat3/entity`'s row observer. The `subscribe` fixture builds it; nothing
 * here mocks a frame.
 *
 * These five tests had never run. They were written against `subscribe(liveFeed.as(actor, input))`
 * — which resolves to a ROW ARRAY, not something subscribable — and the fixture had no driver, so
 * every one of them failed at its first line with `X_TEST_FIXTURE_UNAVAILABLE` (#9). The call is
 * `subscribe(query, input, actor)`: the query, its input, and who is asking, which is what a
 * subscribe frame carries. The actor is the third argument and not baked into the target because
 * that is where the framework puts it — the shared window is built with NO subject, and every
 * decision about an actor is per subscriber.
 */

import { expect, test } from '@ultimat3/testing';
import { publishPost } from './actions';
import type { PostSummary } from './entity';
import { liveFeed } from './live';

test('the initial snapshot is scoped to the actor’s org', async ({ seed, actorFor, subscribe }) => {
  const { ada, acme } = await seed('dev').pick({ ada: 'member:ada', acme: 'org:acme' });

  const feed = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(ada));

  expect(feed.rows().length).toBe(3);
  expect(feed.rows().every((row) => row.orgId === acme.id)).toBe(true);
  expect(feed.snapshots()).toBe(1);
});

/**
 * The assertion this file was WRITTEN with, and it is true as of #230's fix. It was not before:
 * `liveFeed` orders by `createdAt`, `PostSummary` did not carry `createdAt`, and `match()` compared
 * the change row's real value against nothing on the row the client holds — so every change read as
 * a move, one update became a `remove` + `insert` pair, and the re-inserted row was the raw `posts`
 * row. Two fixes met here: the matcher refuses to place a row its window cannot answer for, and the
 * feed row now carries the key it is ordered by.
 */
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

  const feed = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(ada));
  const before = feed.rows().length;

  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  await feed.settled();

  expect(feed.rows().length).toBe(before);
  expect(feed.snapshots()).toBe(1); // patched, never re-read
  expect(feed.patches()).toMatchObject([{ op: 'update', row: { id: draft.id } }]);
  expect(feed.row(draft.id)?.status).toBe('published');
});

/**
 * The half of #230 that is a leak rather than churn, and it is independent of the ordering key: a
 * `ChangeEvent` carries the whole TABLE row, and every patch used to forward it. `body` is the one
 * column this projection exists to drop — "50 bodies is not a feed" — and it reached every
 * subscriber on the first change to any post.
 *
 * Asserted over the frames the subscriber RECEIVED, not over the server's window, because the wire
 * is where the leak was.
 */
test('a patch carries the feed row, never the columns the projection dropped', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme, draft } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    draft: 'post:draft-money',
  });

  const feed = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(ada));
  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  await feed.settled();

  const delivered = feed.patches().flatMap((patch) => Object.keys(patch.row));
  expect(delivered).not.toContain('body');
  expect(delivered).not.toContain('updatedAt');
  // And the rows the subscriber holds keep the feed's own shape, rather than drifting into the
  // table's as patches land on them.
  for (const row of feed.rows()) expect(Object.hasOwn(row, 'body')).toBe(false);
});

test('a row that fails the policy is never delivered', async ({ seed, actorFor, subscribe }) => {
  const { mara, tinta, acme } = await seed('dev').pick({
    mara: 'member:mara',
    tinta: 'org:tinta',
    acme: 'org:acme',
  });

  const feed = await subscribe<PostSummary>(liveFeed, { orgId: tinta.id }, actorFor(mara));

  expect(feed.rows().some((row) => row.orgId === acme.id)).toBe(false);
  await expect(
    subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(mara)),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

/**
 * The second subscriber is load-bearing, not decoration. The retained window a resume replays from
 * is the registry's ENTRY, and the entry is dropped when its last subscriber goes — so a lone
 * subscriber cannot resume from its own reconnect on one node, and the node re-reads instead. What
 * a browser reconnects into is a node other subscribers are holding open. The test below asserts
 * the other half.
 */
test('a reconnect into a held window is a delta, not a snapshot', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, bruno, acme, draft } = await seed('dev').pick({
    ada: 'member:ada',
    bruno: 'member:bruno',
    acme: 'org:acme',
    draft: 'post:draft-money',
  });

  const held = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(bruno));
  const feed = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(ada));

  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  await feed.reconnect();

  expect(feed.snapshots()).toBe(1); // the initial one only
  expect(feed.resubscribedFrom()).toBeDefined();
  expect(held.rows().length).toBe(3);
});

test('a reconnect with nobody holding the window re-reads rather than silently skipping', async ({
  seed,
  actorFor,
  subscribe,
}) => {
  const { ada, acme, draft } = await seed('dev').pick({
    ada: 'member:ada',
    acme: 'org:acme',
    draft: 'post:draft-money',
  });

  const feed = await subscribe<PostSummary>(liveFeed, { orgId: acme.id }, actorFor(ada));
  await publishPost.as(actorFor(ada), { postId: draft.id, orgId: acme.id, notify: false });
  await feed.reconnect();

  expect(feed.snapshots()).toBe(2);
  expect(feed.resubscribedFrom()).toBeUndefined();
  expect(feed.row(draft.id)?.status).toBe('published');
});

/**
 * The offline mutation half — optimistic twin, durable queue, reconcile on reconnect — is NOT here,
 * and deliberately. It is the CLIENT's: `LiveClient`'s local store, its offline queue and its
 * rebase log, reached from a component through `useMutation` and `useMutationQueue`. The
 * `subscribe` fixture holds none of those, and a `feed.local()` that answered with the server row
 * would report the twin as applied whether or not a mutator ever ran — coverage that is worse than
 * none, because it reads as proof.
 *
 * Where it IS proved: `apps/web/e2e/offline-feed.e2e.test.ts` drives the built app in a browser
 * with the network cut, and `site/offline/page.tsx` is the surface it exercises.
 */
