/**
 * unit — no DB, no I/O. The optimistic twin is replayed on every rebase, so the property under
 * test is convergence: applying `local` N times has to leave the same row as applying it once.
 *
 * The store is `@ultimat3/testing`'s `memoryLocalTx`: keyed like the page's record store, with
 * its semantics (a held row is frozen; an `update` of a key it does not hold is a no-op). This
 * file hand-rolled that table and cast it to `LocalTx` until 2026-10-01.
 */

import type { LocalTables } from '@ultimat3/action';
import { expect, memoryLocalTx, unitTest } from '@ultimat3/testing';
import { likePost } from './mutator';

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
