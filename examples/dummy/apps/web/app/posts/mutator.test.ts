/**
 * unit — the optimistic twin first, with no DB and no I/O; `movePostStatus` last, on the seeded
 * in-memory driver. The twin is replayed on every rebase, so the property under
 * test is convergence: applying `local` N times has to leave the same row as applying it once.
 *
 * The store is `@ultimat3/testing`'s `memoryLocalTx`: keyed like the page's record store, with
 * its semantics (a held row is frozen; an `update` of a key it does not hold is a no-op). This
 * file hand-rolled that table and cast it to `LocalTx` until 2026-10-01.
 */

import type { LocalTables } from '@ultimat3/action';
import { expect, memoryLocalTx, test, unitTest } from '@ultimat3/testing';
import { likePost } from './actions/like-post';
import { movePostStatus } from './actions/move-post-status';

type LocalPost = LocalTables['posts'];

const POST = '00000000-0000-4000-8000-0000000000aa';
const ORG = '00000000-0000-4000-8000-000000000002';
const input = { postId: POST, orgId: ORG };

/** The post as the store holds it after `times` applications over one seeded row. */
const applyLocal = (seed: LocalPost, times: number): LocalPost | undefined => {
  const store = memoryLocalTx({ posts: { [POST]: seed } });
  for (let run = 0; run < times; run += 1) likePost.local(store.tx, input);
  return store.rows<LocalPost>('posts')[POST];
};

unitTest('the local twin is replayable: three applications land where one does', () => {
  const unliked = { id: POST, likeCount: 4, likedByMe: false };
  const once = applyLocal(unliked, 1);

  expect(once).toEqual({ id: POST, likeCount: 5, likedByMe: true });
  // A rebase replays the queued mutation. `likeCount + 1` climbed once per replay, so a device
  // that reconnected after three attempts showed three likes for one member.
  expect(applyLocal(unliked, 3)).toEqual({ id: POST, likeCount: 5, likedByMe: true });
});

unitTest('a row this member already liked is left alone', () => {
  // Derived from the flag, not from the previous count: the server half converges the same way,
  // because `insertLike` is insert-or-ignore and `recountLikes` recounts instead of adding.
  const liked = { id: POST, likeCount: 9, likedByMe: true };
  expect(applyLocal(liked, 1)).toEqual(liked);
});

unitTest('a row the local store has never seen is not invented', () => {
  const store = memoryLocalTx();

  likePost.local(store.tx, input);

  expect(store.rows('posts')).toEqual({});
});

// `movePostStatus` — `transition()` over `posts.status`, against the in-memory driver, which answers
// a compare-and-set exactly as Postgres does (`@ultimat3/entity`'s README).

test('movePostStatus schedules a draft and takes it back, one move at a time', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });
  const as = actorFor(bruno);

  const scheduled = await movePostStatus.as(as, { id: draft.id, from: 'draft', to: 'scheduled' });
  expect(scheduled).toMatchObject({ id: draft.id, status: 'scheduled' });

  // A stale `from` — the post already moved — is refused naming the state it is really in.
  await expect(
    movePostStatus.as(as, { id: draft.id, from: 'draft', to: 'scheduled' }),
  ).rejects.toBeUltimateError('X_STATE_CONFLICT');

  const back = await movePostStatus.as(as, { id: draft.id, from: 'scheduled', to: 'draft' });
  expect(back.status).toBe('draft');
});

test('movePostStatus never publishes: the terminal state is not a state it may name', async ({
  seed,
  actorFor,
}) => {
  const { draft, bruno } = await seed('dev').pick({
    draft: 'post:draft-money',
    bruno: 'member:bruno',
  });

  await expect(
    // Refused by the input schema the factory built from `states`, before any statement runs.
    movePostStatus.as(actorFor(bruno), { id: draft.id, from: 'draft', to: 'published' }),
  ).rejects.toBeUltimateError('X_INPUT_INVALID');
});

test('movePostStatus cannot reach another org’s post, nor be called without the grant', async ({
  seed,
  actorFor,
}) => {
  const { draft, mara, reader } = await seed('dev').pick({
    draft: 'post:draft-money',
    mara: 'member:mara',
    reader: 'member:kenji',
  });
  const move = { id: draft.id, from: 'draft', to: 'scheduled' } as const;

  // Mara holds `post:publish` in Tinta: the row loader, scoped to her org, finds no such post, and
  // a missing row is a denial — the same answer `publishPost` gives, and no existence oracle.
  await expect(movePostStatus.as(actorFor(mara), move)).rejects.toBeUltimateError('X_FORBIDDEN');
  await expect(movePostStatus.as(actorFor(reader), move)).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('movePostStatus is owns-or-org-admin, as publishing is: a colleague’s draft is not yours to schedule', async ({
  seed,
  actorFor,
}) => {
  const { draft, ada, kenji } = await seed('dev').pick({
    draft: 'post:draft-money', // Bruno's
    ada: 'member:ada', // Acme's owner
    kenji: 'member:kenji',
  });
  const move = { id: draft.id, from: 'draft', to: 'scheduled' } as const;

  // Kenji as an AUTHOR of the same org: the grant and the tenancy hold, the authorship does not.
  await expect(
    movePostStatus.as(actorFor({ ...kenji, role: 'author' }), move),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
  // The org's owner runs the calendar for everyone.
  expect(await movePostStatus.as(actorFor(ada), move)).toMatchObject({ status: 'scheduled' });
});
