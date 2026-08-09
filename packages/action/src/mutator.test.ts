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
const strangerActor = userActor({ id: 'u2' });
const ctx = createContext({ actor: likerActor });
const stranger = createContext({ actor: strangerActor });

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

/** Counts the declared half's runs: proof that a denied `.server()` never reached it. */
let serverRuns = 0;

const likePost = mutator({
  input: Input,
  output: Output,
  policy: can('post:like'),
  mcp: { expose: true, description: 'Like a post' },
  local(tx, { postId }) {
    tx.table<PostRow>('posts').update(postId, (post) => ({ likes: post.likes + 1 }));
  },
  async server(_ctx, { postId }) {
    serverRuns += 1;
    return { id: postId, likes: 7 };
  },
  conflict: 'server-wins',
}).named('likePost');

describe('mutator', () => {
  test('is an action: it projects a route path and describes as a mutator', () => {
    expect(likePost.describe().path).toBe('/api/posts/like');
    expect(likePost.describeMutator().kind).toBe('mutator');
    expect(likePost.describeMutator().conflict).toBe('server-wins');
    expect(likePost.isMutator).toBe(true);
  });

  test('.local applies the optimistic twin against the client store', () => {
    const rows = new Map<string, PostRow>([[POST_ID, { id: POST_ID, likes: 3 }]]);
    likePost.local(fakeTx(rows), { postId: POST_ID });
    expect(rows.get(POST_ID)?.likes).toBe(4);
  });

  test('.applyLocal is gone: the projected name is the authored one, once', () => {
    expect('applyLocal' in likePost).toBe(false);
  });

  test('.server returns the authoritative value', async () => {
    expect(await likePost.server(ctx, { postId: POST_ID })).toEqual({ id: POST_ID, likes: 7 });
    // Same value over the raw core, so `.server` is that core and not a shortcut past it.
    expect(await invoke(likePost, { postId: POST_ID }, { ctx })).toEqual({
      id: POST_ID,
      likes: 7,
    });
  });

  test('.server is not a second execution path: the policy still denies', async () => {
    const before = serverRuns;
    const denial = await likePost.server(stranger, { postId: POST_ID }).catch((e: unknown) => e);
    expect((denial as { code?: string }).code).toBe('X_FORBIDDEN');

    const anonymous = await likePost
      .server(createContext({}), { postId: POST_ID })
      .catch((e: unknown) => e);
    expect((anonymous as { code?: string }).code).toBe('X_UNAUTHENTICATED');
    expect(serverRuns).toBe(before);
  });

  test('.server parses its input before the declared half runs', async () => {
    const before = serverRuns;
    const failure = await likePost.server(ctx, { postId: 'not-a-uuid' }).catch((e: unknown) => e);
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect(serverRuns).toBe(before);
  });

  test('a renamed mutator keeps both halves, its conflict and the action façade', async () => {
    const renamed = likePost.named('favoritePost');
    expect(renamed.isMutator).toBe(true);
    expect(renamed.conflict).toBe('server-wins');
    expect(renamed.describeMutator().conflict).toBe('server-wins');
    expect(renamed.describe().name).toBe('favoritePost');

    const rows = new Map<string, PostRow>([[POST_ID, { id: POST_ID, likes: 3 }]]);
    renamed.local(fakeTx(rows), { postId: POST_ID });
    expect(rows.get(POST_ID)?.likes).toBe(4);
    expect(await renamed.server(ctx, { postId: POST_ID })).toEqual({ id: POST_ID, likes: 7 });

    // The inherited façade, member by member: a rewrap that drops one is a regression.
    expect(renamed.input).toBe(Input);
    expect(renamed.output).toBe(Output);
    expect(renamed.policy).toBe(likePost.policy);
    expect(renamed.mcp).toEqual({ expose: true, description: 'Like a post' });
    expect(await renamed.as(likerActor, { postId: POST_ID })).toEqual({ id: POST_ID, likes: 7 });
    expect(renamed.tool().name).toBe('favorite_post');
    expect(renamed.openapi().operationId).toBe('favoritePost');
    expect(typeof renamed.client({ baseUrl: 'https://app.test' })).toBe('function');
    expect(renamed.job().name).toBe('action:favoritePost');
    expect(renamed.contract().map((contract) => contract.name)).toEqual([
      'favoritePost: input schema rejects garbage',
      'favoritePost: policy denies an anonymous actor',
      'favoritePost: OpenAPI document contains its operation',
    ]);
    // The original keeps its own name: renaming twins, it never mutates in place.
    expect(likePost.describe().name).toBe('likePost');
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
