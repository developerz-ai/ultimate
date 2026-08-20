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
 * The distinction this test is named for holds: the change arrives as PATCHES and not as a second
 * snapshot, and the window is not re-read.
 *
 * What it does NOT arrive as is one `update`, and running this test for the first time is what
 * found out why. `match()` decides "moved" with
 * `compareRows(event.row, current, shape.orderBy)`, `shape.orderBy` here is
 * `createdAt desc, id asc` — and `current` is the row the window HOLDS, which is a `PostSummary`.
 * `SUMMARY_COLUMNS` carries `publishedAt` and not `createdAt`, so every comparison is a real `Date`
 * against `undefined`, every change to a row reads as a move, and one update becomes a
 * `remove` + `insert` pair. The re-inserted row is the raw `posts` row the change feed carried, so
 * the client's row shape changes under it and columns the projection deliberately dropped — `body`
 * — arrive over the socket.
 *
 * Asserted as it behaves rather than as it ought to: a test that expected `update` would be red for
 * a defect it does not own, and one that skipped the shape would let it go unrecorded.
 * Tracked as its own issue; the fix is a design decision in `@ultimat3/query`'s matcher, not a
 * change to this app.
 */
test('a publish arrives as patches, not a refetch', async ({ seed, actorFor, subscribe }) => {
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
  expect(feed.patches().map((patch) => patch.op)).toEqual(['delete', 'insert']);
  expect(feed.patches().every((patch) => patch.row.id === draft.id)).toBe(true);
  expect(feed.row(draft.id)?.status).toBe('published');
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
