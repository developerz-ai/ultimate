import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { invoke } from './invoke';
import type { LocalRow, LocalTable, LocalTx } from './mutator';
import { custom, mutator, resolveConflict } from './mutator';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, likes: t.number });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const likerActor = { ...userActor({ id: 'u1' }), permissions: ['post:like'] };
const ctx = createContext({ actor: likerActor });

interface PostRow extends LocalRow {
  readonly likes: number;
}

/** The Map-backed LocalTx @ultimat3/realtime implements over OPFS SQLite. */
function fakeTx(rows: Map<string, PostRow>) {
  const table: LocalTable<PostRow> = {
    insert: (row) => {
      rows.set(row.id, row);
    },
    update: (id, patch) => {
      const current = rows.get(id);
      if (current === undefined) return;
      const next = typeof patch === 'function' ? patch(current) : patch;
      rows.set(id, { ...current, ...next });
    },
    delete: (id) => {
      rows.delete(id);
    },
  };
  return { table: () => table } as unknown as LocalTx;
}

const toggleLike = mutator({
  input: Input,
  output: Output,
  policy: can('post:like'),
  local(tx, { postId }) {
    tx.table<PostRow>('posts').update(postId, (post) => ({ likes: post.likes + 1 }));
  },
  async server(_ctx, { postId }) {
    return { id: postId, likes: 7 };
  },
  conflict: 'server-wins',
}).named('toggleLike');

describe('mutator', () => {
  test('is an action: it projects a route path and describes as a mutator', () => {
    expect(toggleLike.describe().path).toBe('/api/likes/toggle');
    expect(toggleLike.describeMutator().kind).toBe('mutator');
    expect(toggleLike.describeMutator().conflict).toBe('server-wins');
    expect(toggleLike.isMutator).toBe(true);
  });

  test('the local twin writes optimistically, the server twin is authoritative', async () => {
    const rows = new Map<string, PostRow>([[POST_ID, { id: POST_ID, likes: 3 }]]);
    toggleLike.applyLocal(fakeTx(rows), { postId: POST_ID });
    expect(rows.get(POST_ID)?.likes).toBe(4);

    const authoritative = await invoke(toggleLike, { postId: POST_ID }, { ctx });
    expect(authoritative).toEqual({ id: POST_ID, likes: 7 });
  });

  test('conflict strategies pick a winner', () => {
    const local = { id: POST_ID, likes: 4 };
    const server = { id: POST_ID, likes: 7 };
    expect(resolveConflict('server-wins', local, server)).toBe(server);
    expect(resolveConflict('last-write-wins', local, server)).toBe(local);
    const merge = custom<typeof local>((a, b) => ({ id: a.id, likes: Math.max(a.likes, b.likes) }));
    expect(resolveConflict(merge, local, server)).toEqual(server);
  });
});
