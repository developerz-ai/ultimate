/**
 * unit — no DB, no I/O. The optimistic twin is replayed on every rebase, so the property under
 * test is convergence: applying `local` N times has to leave the same row as applying it once.
 */

import { expect, test } from 'bun:test';
import type { LocalTable, LocalTables, LocalTx } from '@ultimat3/action';
import { likePost } from './mutator';

type LocalPost = LocalTables['posts'];

const POST = '00000000-0000-4000-8000-0000000000aa';
const ORG = '00000000-0000-4000-8000-000000000002';

/** The Map-backed LocalTx @ultimat3/realtime implements over OPFS SQLite. */
const fakeTx = (rows: Map<string, LocalPost>): LocalTx => {
  const posts: LocalTable<LocalPost> = {
    insert: (row) => {
      rows.set(row.id, row);
    },
    update: (id, patch) => {
      const current = rows.get(id);
      if (current === undefined) return;
      rows.set(id, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
  // One cast, at one seam: `LocalTx` also carries the string-keyed escape hatch generated code
  // uses, and this app's twin only ever addresses `tx.posts`.
  return { posts } as unknown as LocalTx;
};

const applyLocal = (times: number): LocalPost | undefined => {
  const rows = new Map<string, LocalPost>([[POST, { id: POST, likeCount: 4, likedByMe: false }]]);
  const tx = fakeTx(rows);
  for (let run = 0; run < times; run += 1) likePost.local(tx, { postId: POST, orgId: ORG });
  return rows.get(POST);
};

test('the local twin is replayable: three applications land where one does', () => {
  const once = applyLocal(1);

  expect(once).toEqual({ id: POST, likeCount: 5, likedByMe: true });
  // A rebase replays the queued mutation. `likeCount + 1` climbed once per replay, so a device
  // that reconnected after three attempts showed three likes for one member.
  expect(applyLocal(3)).toEqual(once as LocalPost);
});

test('a row this member already liked is left alone', () => {
  const rows = new Map<string, LocalPost>([[POST, { id: POST, likeCount: 9, likedByMe: true }]]);

  likePost.local(fakeTx(rows), { postId: POST, orgId: ORG });

  // Derived from the flag, not from the previous count: the server half converges the same way,
  // because `insertLike` is insert-or-ignore and `recountLikes` recounts instead of adding.
  expect(rows.get(POST)).toEqual({ id: POST, likeCount: 9, likedByMe: true });
});

test('a row the local store has never seen is not invented', () => {
  const rows = new Map<string, LocalPost>();

  likePost.local(fakeTx(rows), { postId: POST, orgId: ORG });

  expect(rows.size).toBe(0);
});
