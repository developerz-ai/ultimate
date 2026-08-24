// The semantic cache half of `llm()`: what a partition is, and — the guarantee that matters —
// that a declaration which names none does NOT put every tenant in one store. `lookup` is a cosine
// nearest neighbour with no tenant predicate, so partitioning is the only thing that makes a
// cross-tenant answer structurally impossible.

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import {
  ANSWER,
  ctxFor,
  declare,
  install,
  OTHER_ID,
  POST_ID,
  promptFor,
  stub,
} from './llm-fixture';
import { resetAiRuntime } from './runtime';

beforeEach(() => {
  resetAiRuntime();
});

describe('the semantic cache', () => {
  test('a repeated prompt is answered without a second model call', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.99, ttl: '7d' } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(1);
  });

  test('scopes are separate stores, so one tenant never reads another tenant answer', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    let tenant = 'org-a';
    const summarize = declare(promptFor(), {
      // Same rendered prompt, different scope: a shared store would hit on cosine alone.
      cache: { semantic: { threshold: 0.5, scope: () => tenant } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    tenant = 'org-b';
    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });

  test('a prompt version bump invalidates it — that is what the bump is for', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const cache = { semantic: { threshold: 0.99 } } as const;
    const v1 = declare(promptFor('bumped', '1.0.0'), { cache });
    await v1({ postId: POST_ID }, { ctx: anonymousCtx() });
    await v1({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(1);

    const v2 = declare(promptFor('bumped', '2.0.0'), { cache });
    await v2({ postId: POST_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });

  // S2. The default was `'global'`: one store for the whole process, and `lookup` is a cosine
  // nearest neighbour with no tenant predicate. `runtime.ts` states the rule correctly — "cosine
  // similarity has no notion of a tenant, so two tenants asking near-identical questions of a
  // shared cache is one tenant reading the other's answer" — and the default contradicted it.
  test('two tenants asking the SAME prompt do not share an answer by default', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    // No `scope` at all — the shape `wiki/Money.md` and `wiki/MCP-And-AI.md` both print.
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('grace', 'org-b') });
    expect(seen.length).toBe(2);
  });

  test('the same actor still hits — the default narrows, it does not disable', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    expect(seen.length).toBe(1);
  });

  test('two actors of ONE org do not share either — narrowest, not tenant-wide', async () => {
    // `readAuthority`'s rule: a read that says nothing gets the narrowest key. Widening to a
    // tenant is a statement about what the rows are, and it has to be written down.
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('linus', 'org-a') });
    expect(seen.length).toBe(2);
  });

  /**
   * The reported symptom, and the reason this is a partition rather than a prompt fix: the model
   * is TOLD the locale (`Write the summary in the locale {{locale}}`), so it answers correctly —
   * and the cache then hands one reader the other's language. `lookup` is a cosine nearest
   * neighbour, and `en` against `es` is one token in a prompt carrying a whole post: measured
   * with this package's own `HashEmbedder`, two renderings of the reference app's summarize
   * template differing ONLY in that token sit at **0.9986**, against a declared threshold of
   * 0.97. No threshold an app can defend separates them — 0.999 would also lose an honest repeat.
   */
  test('two locales are two answers, so a summary never comes back in the wrong language', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a', 'es') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a', 'en') });
    expect(seen.length).toBe(2);
  });

  test('one locale still hits — the partition narrows, it does not disable', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), { cache: { semantic: { threshold: 0.5 } } });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a', 'es') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a', 'es') });
    expect(seen.length).toBe(1);
  });

  /**
   * A declared `scope` answers "who may share this answer". The locale is not that question — it
   * is part of what the answer IS, like the prompt version — so it partitions a written-down
   * shared store too. An app that writes `scope: () => 'global'` is stating that every caller may
   * read one another's summaries, never that a Spanish one will do for an English reader.
   */
  test('a written-down shared cache is still not shared ACROSS locales', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.5, scope: () => 'global' } },
    });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a', 'es') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('grace', 'org-b', 'en') });
    expect(seen.length).toBe(2);
  });

  test('a shared cache is possible, and has to be written down', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.5, scope: () => 'global' } },
    });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('grace', 'org-b') });
    expect(seen.length).toBe(1);
  });

  test('scope is handed the ctx as well as the input, like vars()', async () => {
    // It took `input` alone, so the ONE thing a partition may never be chosen by — a value the
    // caller sends — was the only thing it could be chosen by.
    const { provider } = stub(ANSWER);
    install(provider);
    const seenArgs: { input: { postId: string }; actorId: string }[] = [];
    const summarize = declare(promptFor(), {
      cache: {
        semantic: {
          threshold: 0.99,
          scope: ({ input, ctx }) => {
            seenArgs.push({ input, actorId: ctx.actor.id });
            return ctx.actor.orgId ?? 'none';
          },
        },
      },
    });

    await summarize({ postId: POST_ID }, { ctx: ctxFor('ada', 'org-a') });
    expect(seenArgs).toEqual([{ input: { postId: POST_ID }, actorId: 'ada' }]);
  });

  test('an unrelated input misses, so the cache never answers the wrong question', async () => {
    const { provider, seen } = stub(ANSWER);
    install(provider);
    const summarize = declare(promptFor(), {
      cache: { semantic: { threshold: 0.99 } },
    });

    await summarize({ postId: POST_ID }, { ctx: anonymousCtx() });
    await summarize({ postId: OTHER_ID }, { ctx: anonymousCtx() });
    expect(seen.length).toBe(2);
  });
});
