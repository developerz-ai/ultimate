import { describe, expect, test } from 'bun:test';
import { createContext, resolveConflict, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import * as barrel from './index';
import { invoke } from './invoke';
import type { LocalTable, LocalTx } from './mutator';
import { custom, isMutator, mutator } from './mutator';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, likes: t.number });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const likerActor = { ...userActor({ id: 'u1' }), permissions: ['post:like'] };
const strangerActor = userActor({ id: 'u2' });
const ctx = createContext({ actor: likerActor });
const stranger = createContext({ actor: strangerActor });

interface PostRow {
  readonly id: string;
  readonly likes: number;
}

/** The Map-backed LocalTx @ultimat3/realtime implements over OPFS SQLite. */
function fakeTx(rows: Map<string, PostRow>) {
  const table: LocalTable<PostRow> = {
    get: (key) => rows.get(key),
    all: () => [...rows.values()],
    insert: (key, row) => {
      rows.set(key, row);
    },
    upsert: (key, row) => {
      rows.set(key, { ...rows.get(key), ...row });
    },
    update: (key, patch) => {
      const current = rows.get(key);
      if (current === undefined) return;
      rows.set(key, { ...current, ...(typeof patch === 'function' ? patch(current) : patch) });
    },
    delete: (key) => {
      rows.delete(key);
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

  // `describeActions()` hands the registry back as `ActionDescriptor`, so `kind` stays `'action'`
  // here and `mutator` is the only thing left telling the manifest these two apart.
  test('the plain descriptor still reports it as a mutator', () => {
    expect(likePost.describe().kind).toBe('action');
    expect(likePost.describe().mutator).toBe(true);
    expect(likePost.describeMutator().mutator).toBe(true);
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
    // A rewrap that dropped the brand would file the twin as a plain action in the manifest.
    expect(renamed.describe().mutator).toBe(true);

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
    expect(renamed.tool().name).toBe('favoritePost');
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

  test('isMutator is structural: the brand alone does not counterfeit one', () => {
    expect(isMutator(likePost)).toBe(true);
    // A look-alike carrying the brand has no declaration, so nothing can run it —
    // the same refusal `isAction` gives a hand-rolled `kind: 'action'` object.
    const counterfeit = Object.assign(() => Promise.resolve({}), {
      kind: 'action' as const,
      isMutator: true as const,
    });
    expect(isMutator(counterfeit)).toBe(false);
    expect(isMutator({ isMutator: true })).toBe(false);
  });

  test("conflict strategies pick a winner, through core's one resolver", () => {
    // `last-write-wins` is decided by the server's own clock field, never by which side is local.
    const local = { id: POST_ID, likes: 4, updatedAt: 2 };
    const server = { id: POST_ID, likes: 7, updatedAt: 1 };
    expect(resolveConflict('server-wins', local, server)).toBe(server);
    expect(resolveConflict('last-write-wins', local, server)).toBe(local);
    expect(resolveConflict('last-write-wins', { ...local, updatedAt: 0 }, server)).toBe(server);
  });

  test("custom(merge) is core's row-shaped policy, and merge receives both ROWS", () => {
    const seen: unknown[] = [];
    const policy = custom<{ id: string; likes: number }>((a, b) => {
      seen.push(a, b);
      return { id: a.id, likes: Math.max(a.likes, b.likes) };
    });
    const local = { id: POST_ID, likes: 9 };
    const server = { id: POST_ID, likes: 7 };

    // The shape IS core's ConflictPolicy: `kind`, never the deleted output-shaped `strategy`.
    expect(typeof policy === 'string' ? policy : policy.kind).toBe('custom');
    expect(resolveConflict(policy, local, server)).toEqual({ id: POST_ID, likes: 9 });
    expect(seen).toEqual([local, server]);
  });

  test('a custom policy declared on a mutator is the one its descriptor names', () => {
    const merging = mutator({
      input: Input,
      output: Output,
      policy: can('post:like'),
      local() {},
      server: (_ctx, input) => ({ id: input.postId, likes: 1 }),
      conflict: custom((_local, server) => server),
    }).named('mergePost');
    expect(merging.describeMutator().conflict).toBe('custom');
    const conflict = merging.conflict;
    expect(typeof conflict === 'string' ? conflict : conflict.kind).toBe('custom');
  });

  test('the output-shaped resolver is gone from this package — core owns the one', () => {
    // A second `resolveConflict` here is how two conflict vocabularies drifted apart.
    expect(Object.hasOwn(barrel, 'resolveConflict')).toBe(false);
    expect(Object.hasOwn(barrel, 'strategyOf')).toBe(false);
  });
});

/**
 * A mutator IS an action, so it declares what an action declares. `row`, `rateLimit` and
 * `deprecated` were dropped on the way into `actionDef`: a row-level policy on a mutator received
 * `row === null` and denied every call, including the row's own author.
 */
describe('a mutator carries the action fields it was missing', () => {
  const owned = (ownerId: string) =>
    mutator({
      input: Input,
      output: Output,
      policy: can<{ postId: string }, { ownerId: string }>(
        'post:like',
        ({ actor, row }) => row !== null && row.ownerId === actor?.id,
      ),
      row: () => ({ ownerId }),
      rateLimit: { limit: 5, windowMs: 60_000 },
      deprecated: { since: '2026-08-01T00:00:00Z', sunset: '2026-12-31T23:59:59Z' },
      local() {},
      server: (_ctx, { postId }) => ({ id: postId, likes: 1 }),
      conflict: 'server-wins',
    }).named('likeOwnPost');

  test('the row reaches the policy, so the owner is allowed', async () => {
    const owner = createContext({
      actor: { ...userActor({ id: 'u1' }), permissions: ['post:like'] },
    });
    const liked = await invoke(owned('u1'), { postId: POST_ID }, { ctx: owner });
    expect((liked as { readonly likes: number }).likes).toBe(1);
  });

  test('rateLimit and deprecated reach the action definition', () => {
    const described = owned('u1').describe();
    expect(described.deprecated).not.toBeNull();
    expect(described.rateLimit).not.toBeNull();
  });
});
