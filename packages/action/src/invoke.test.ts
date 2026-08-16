import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import type { CacheTier } from '@ultimat3/cache';
import {
  declareTags,
  isolateDeclaredTags,
  isolateTiers,
  registerTier,
  resetDeclaredTags,
  resetTiers,
  tag,
} from '@ultimat3/cache';
import { createContext, userActor } from '@ultimat3/core';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action, describeAction, isAction } from './action';
import { MemoryIdempotencyStore } from './idempotency';
import { invoke } from './invoke';
import type { Surface } from './policy-gate';
import { listActions, registerActions, resetRegistry } from './registry';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const editorActor = { ...userActor({ id: 'u1' }), permissions: ['post:publish'] };
const readerActor = userActor({ id: 'u2' });
const editor = createContext({ actor: editorActor });
const SURFACES: readonly Surface[] = ['server', 'http', 'mcp', 'job'];

/** The two halves a row rule needs: what the surface parsed, and what it loaded. */
type Parsed = { readonly postId: string };
type Draft = { readonly authorId: string };

/** Fails closed: `null` is "no loader" or "no such row", and neither grants anything. */
const ownDraft = can<Parsed, Draft>(
  'post:publish',
  ({ actor, row }) => row !== null && row.authorId === actor?.id,
);

afterEach(() => {
  resetRegistry();
});

describe('the invocation core', () => {
  test('parses the output and drops fields the schema never declared', async () => {
    const leaky = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      // A handler that hands back the whole row is the common shape of a data leak.
      handle: ({ input }) => ({ id: input.postId, published: true, passwordHash: 'secret' }),
    }).named('publishPost');

    const result = await invoke(leaky, { postId: POST_ID }, { ctx: editor });

    expect(result).toEqual({ id: POST_ID, published: true });
    expect(Object.keys(result as object)).not.toContain('passwordHash');
  });

  test('a handler that drifts from its output schema fails with X_OUTPUT_INVALID', async () => {
    const drifted = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: 'yes' }),
    }).named('publishPost');

    const failure = await invoke(drifted, { postId: POST_ID }, { ctx: editor }).catch(
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe('X_OUTPUT_INVALID');
    expect((failure as { cause?: string }).cause).toContain('published');
  });

  test('every surface parses, authorizes and runs through the same core', async () => {
    let runs = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => {
        runs += 1;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const reader = createContext({ actor: readerActor });
    for (const surface of SURFACES) {
      expect(await invoke(target, { postId: POST_ID }, { ctx: editor, surface })).toEqual({
        id: POST_ID,
        published: true,
      });
      const bad = await invoke(target, { postId: 'nope' }, { ctx: editor, surface }).catch(
        (error: unknown) => error,
      );
      expect((bad as { code?: string }).code).toBe('X_INPUT_INVALID');
      const denied = await invoke(target, { postId: POST_ID }, { ctx: reader, surface }).catch(
        (error: unknown) => error,
      );
      expect((denied as { code?: string }).code).toBe('X_FORBIDDEN');
    }
    // One run per surface: neither the denial nor the bad input ever reached the handler.
    expect(runs).toBe(SURFACES.length);
  });

  test('`actor` swaps who is asking and keeps the rest of the context', async () => {
    const seen: { actor: string | null; requestId: string | null } = {
      actor: null,
      requestId: null,
    };
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input, ctx }) => {
        seen.actor = ctx.actor.id;
        seen.requestId = ctx.requestId;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    await invoke(target, { postId: POST_ID }, { ctx: editor, actor: editorActor });

    expect(seen.actor).toBe('u1');
    expect(seen.requestId).toBe(editor.requestId);
  });

  test('a replayed idempotent response is the parsed value too', async () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      idempotent: true,
      handle: ({ input }) => ({ id: input.postId, published: true, passwordHash: 'secret' }),
    }).named('publishPost');
    const options = { ctx: editor, store: new MemoryIdempotencyStore(), idempotencyKey: 'k1' };

    const first = await invoke(target, { postId: POST_ID }, options);
    const replay = await invoke(target, { postId: POST_ID }, options);

    expect(replay).toEqual(first);
    expect(replay).toEqual({ id: POST_ID, published: true });
  });

  test('no row loader hands the rule `row: null`', async () => {
    const seen: unknown[] = [];
    const target = action({
      input: Input,
      output: Output,
      policy: can<Parsed, Draft>('post:publish', ({ row }) => {
        seen.push(row);
        return true;
      }),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

    await invoke(target, { postId: POST_ID }, { ctx: editor });

    // `null`, never `undefined`: an absent row is a value the predicate branches on.
    expect(seen).toEqual([null]);
  });

  test('a declared loader reaches the predicate, and does so before the handler', async () => {
    const order: string[] = [];
    const seen: (Draft | null)[] = [];
    const target = action({
      input: Input,
      output: Output,
      policy: can<Parsed, Draft>('post:publish', ({ row }) => {
        order.push('policy');
        seen.push(row);
        return true;
      }),
      row: async ({ input }) => {
        order.push('row');
        return { authorId: `wrote-${input.postId}` };
      },
      handle: ({ input }) => {
        order.push('handle');
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    await invoke(target, { postId: POST_ID }, { ctx: editor });

    // Load, decide, then act. A handler that ran first would be the authorization.
    expect(order).toEqual(['row', 'policy', 'handle']);
    expect(seen).toEqual([{ authorId: `wrote-${POST_ID}` }]);
  });

  test('a denial from a row rule short-circuits the handler', async () => {
    let runs = 0;
    // One policy, one actor, one input — the loaded row is the only thing that differs,
    // so the pair fails unless the row genuinely reaches the predicate.
    const publisher = (authorId: string) =>
      action({
        input: Input,
        output: Output,
        policy: ownDraft,
        row: () => ({ authorId }),
        handle: ({ input }) => {
          runs += 1;
          return { id: input.postId, published: true };
        },
      }).named('publishPost');

    expect(await invoke(publisher('u1'), { postId: POST_ID }, { ctx: editor })).toEqual({
      id: POST_ID,
      published: true,
    });

    const failure = await invoke(publisher('u2'), { postId: POST_ID }, { ctx: editor }).catch(
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe('X_FORBIDDEN');
    expect(runs).toBe(1); // the author's own draft only
  });

  test('a loader that finds nothing denies rather than falling through', async () => {
    let ran = false;
    const target = action({
      input: Input,
      output: Output,
      policy: ownDraft,
      // The hole this exists to close: a row the surface could not load used to reach
      // the rule as `null` and be read as "no row-level objection".
      row: () => null,
      handle: ({ input }) => {
        ran = true;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const failure = await invoke(target, { postId: POST_ID }, { ctx: editor }).catch(
      (error: unknown) => error,
    );

    expect((failure as { code?: string }).code).toBe('X_FORBIDDEN');
    expect(ran).toBe(false);
  });

  test('the declaration is unreachable — an action carries no def', () => {
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

    expect('def' in target).toBe(false);
    expect('handle' in target).toBe(false);
    expect(Object.keys(target)).not.toContain('def');
  });

  test('a row loader runs once per invocation, not once per rule', async () => {
    let loads = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can<Parsed, Draft>('post:publish', () => true),
      row: () => {
        loads += 1;
        return { authorId: 'u1' };
      },
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

    await invoke(target, { postId: POST_ID }, { ctx: editor });

    expect(loads).toBe(1);
  });

  test('a look-alike is not an action: it never registers and never projects', () => {
    const impostor = Object.assign(() => Promise.resolve(null), { kind: 'action' as const });
    Object.defineProperty(impostor, 'name', { value: 'publishPost', configurable: true });

    expect(isAction(impostor)).toBe(false);
    expect(registerActions({ impostor })).toEqual([]);
    expect(listActions()).toEqual([]);

    const failure = (() => {
      try {
        describeAction(impostor as unknown as AnyAction);
      } catch (error: unknown) {
        return error;
      }
      return null;
    })();
    expect((failure as { code?: string }).code).toBe('X_ACTION_FOREIGN');
  });
});

describe('cache invalidation after the handler settles', () => {
  /** Counts what the fan-out reached, so "busted once" and "busted at all" are both assertable. */
  function countingTier(count: { value: number }): CacheTier {
    return {
      name: 'lru',
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      del: () => Promise.resolve(),
      invalidateTags: (tags) => {
        count.value++;
        return Promise.resolve({ tier: 'lru' as const, keys: tags.map((value) => value.entity) });
      },
    };
  }

  // Per-test reset is this describe's own; the restore is what the rest of the process is owed —
  // a reset drops a neighbour's registrations, and the leak guard sees additions only.
  const restoreTiers = isolateTiers();
  const restoreTags = isolateDeclaredTags();

  afterEach(() => {
    resetTiers();
    resetDeclaredTags();
  });

  afterAll(() => {
    restoreTiers();
    restoreTags();
  });

  test('a bust that refuses does not fail the write it was meant to follow', async () => {
    declareTags(['post']);
    let handled = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      // `feed` is not a declared entity, so the fan-out raises X_CACHE_TAG_UNKNOWN — after the
      // handler has already committed.
      cache: { invalidates: [tag('feed')] },
      handle: ({ input }) => {
        handled++;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');

    const result = await invoke(target, { postId: POST_ID }, { ctx: editor });

    expect(result).toEqual({ id: POST_ID, published: true });
    expect(handled).toBe(1);
  });

  test('a replay busts nothing: the first call already did', async () => {
    declareTags(['post']);
    const busts = { value: 0 };
    registerTier(countingTier(busts));
    let handled = 0;
    const target = action({
      input: Input,
      output: Output,
      policy: can('post:publish'),
      idempotent: true,
      cache: { invalidates: [tag('post')] },
      handle: ({ input }) => {
        handled++;
        return { id: input.postId, published: true };
      },
    }).named('publishPost');
    const options = { ctx: editor, store: new MemoryIdempotencyStore(), idempotencyKey: 'k1' };

    await invoke(target, { postId: POST_ID }, options);
    expect(busts.value).toBe(1);

    await invoke(target, { postId: POST_ID }, options);

    // The handler ran once, so the tags were busted once — a retry loop must not re-purge the
    // CDN and re-queue ISR for a write nobody made.
    expect(handled).toBe(1);
    expect(busts.value).toBe(1);
  });
});
