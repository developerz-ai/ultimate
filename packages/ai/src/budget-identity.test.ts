// Single responsibility: a gateway's `actor` / `org` ceilings bind every model call an app makes —
// `llm()`, `agent()` and a `hive()`'s members — under the caller's own identity, and hold when
// many of those calls race one counter. Each was inert: no call derived a key, a hive rooted on an
// empty ledger, and each call's reservation queued on a turnstile nobody else shared.

import { beforeEach, describe, expect, test } from 'bun:test';
import { action, resetActions } from '@ultimat3/action';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import type { BudgetLimits, BudgetStore, BudgetTake } from './budget';
import { budgetKeysFor, type MemoryBudgetStore, memoryBudgetStore } from './budget';
import { providerGateway } from './gateway';
import { hive } from './hive';
import { ANSWER, ctxFor, declare, POST_ID, promptFor, stub } from './llm-fixture';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { Provider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

// The framework registers no model: this suite registers the rows it names (`model-fixture.ts`).
useFixtureModels();

beforeEach(() => {
  resetAiRuntime();
  resetActions();
});

/** The store, wrapped so a test can read what each reservation asked for. */
function recording(): { store: BudgetStore; takes: number[]; inner: MemoryBudgetStore } {
  const inner = memoryBudgetStore();
  const takes: number[] = [];
  return {
    inner,
    takes,
    store: {
      spent: (key) => inner.spent(key),
      add: (key, tokens) => inner.add(key, tokens),
      reset: (key) => inner.reset(key),
      async take(key, tokens, limit): Promise<BudgetTake> {
        takes.push(tokens);
        // An await INSIDE the store's own call, as a network store has: the atomicity has to be
        // the store's, never the scheduler's.
        await Promise.resolve();
        return inner.take(key, tokens, limit);
      },
    },
  };
}

function install(provider: Provider, limits: BudgetLimits, store: BudgetStore): void {
  configureAi({
    gateway: providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [provider],
      budget: limits,
      budgetStore: store,
    }),
  });
}

/** One reservation's size for the shared `declare()` call, measured rather than restated. */
async function oneEstimate(): Promise<number> {
  const { store, takes } = recording();
  install(stub(ANSWER).provider, { actor: 1_000_000 }, store);
  await declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('probe', 'acme') });
  const first = takes[0];
  if (first === undefined)
    expect.unreachable('the actor ceiling took nothing — no key was derived');
  resetAiRuntime();
  return first;
}

describe('budgetKeysFor', () => {
  test('the actor key is kind and id; the org key exists only when the actor has one', () => {
    expect(budgetKeysFor(userActor({ id: 'u-1', orgId: 'acme' }))).toEqual({
      actorKey: 'actor:user:u-1',
      orgKey: 'org:acme',
    });
    expect(budgetKeysFor(userActor({ id: 'u-1' }))).toEqual({ actorKey: 'actor:user:u-1' });
  });
});

describe('an llm() runs under its caller’s actor and org ceilings', () => {
  test('the second call of one actor is refused; another actor still runs', async () => {
    const estimate = await oneEstimate();
    const { provider, seen } = stub(ANSWER);
    install(provider, { actor: estimate + 1 }, memoryBudgetStore());
    const summarize = declare(promptFor());

    await summarize({ postId: POST_ID }, { ctx: ctxFor('u-1', 'acme') });
    await expect(
      summarize({ postId: POST_ID }, { ctx: ctxFor('u-1', 'acme') }),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    await summarize({ postId: POST_ID }, { ctx: ctxFor('u-2', 'acme') });
    expect(seen.length).toBe(2);
  });

  test('two actors of one org share the org ceiling', async () => {
    const estimate = await oneEstimate();
    const { provider, seen } = stub(ANSWER);
    install(provider, { org: estimate + 1 }, memoryBudgetStore());
    const summarize = declare(promptFor());

    await summarize({ postId: POST_ID }, { ctx: ctxFor('u-1', 'acme') });
    await expect(
      summarize({ postId: POST_ID }, { ctx: ctxFor('u-2', 'acme') }),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(seen.length).toBe(1);
  });
});

describe('an agent() runs under its caller’s org ceiling', () => {
  test('a second run in the same org is refused before the provider', async () => {
    const { store, takes } = recording();
    const { provider, seen } = stub({ answer: 'ok' });
    install(provider, { org: 1_000_000 }, store);
    const support = agent({
      input: t.object({ q: t.string }),
      output: t.object({ answer: t.string }),
      prompt: definePrompt<{ q: string }>({ id: 'org-agent', version: '1.0.0', template: '{{q}}' }),
      vars: ({ input }) => ({ q: input.q }),
      tools: [],
      policy: allow(),
    }).named('orgAgent');
    await support({ q: 'a' }, { ctx: ctxFor('u-1', 'acme') });
    const estimate = takes[0] ?? 0;
    expect(estimate).toBeGreaterThan(0);

    install(provider, { org: estimate + 1 }, memoryBudgetStore());
    await support({ q: 'a' }, { ctx: ctxFor('u-1', 'acme') });
    await expect(support({ q: 'a' }, { ctx: ctxFor('u-9', 'acme') })).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(seen.length).toBe(2);
  });
});

describe('a hive()’s members run under the gateway budget', () => {
  const fanOutOf = (name: string) =>
    hive({
      input: t.object({}),
      member: declare(promptFor()),
      split: () => [{ postId: POST_ID }, { postId: POST_ID }, { postId: POST_ID }],
      concurrency: 1,
      onMemberError: 'collect',
      policy: allow(),
    }).named(name);

  test('a gateway request ceiling refuses every member, as it refuses a direct call', async () => {
    const { provider, seen } = stub(ANSWER);
    configureAi({
      gateway: providerGateway({
        defaultModel: FIXTURE_MODEL,
        providers: [provider],
        budget: { request: 1 },
      }),
    });
    const result = await fanOutOf('requestCappedHive')({}, { ctx: ctxFor('u-1', 'acme') });
    expect(result.failed).toBe(3);
    expect(seen.length).toBe(0);
  });

  test('the per-actor ceiling counts the members against the caller', async () => {
    const estimate = await oneEstimate();
    const { provider, seen } = stub(ANSWER);
    install(provider, { actor: estimate + 1 }, memoryBudgetStore());
    const result = await fanOutOf('actorCappedHive')({}, { ctx: ctxFor('u-1', 'acme') });
    // Serial members: the first records its real (smaller) use, and the window still cannot hold
    // a second full estimate on top of it.
    expect(result.ok).toBe(1);
    expect(result.failed).toBe(2);
    expect(seen.length).toBe(1);
  });

  test('a hive of plain actions needs no gateway at all', async () => {
    const plain = action({
      input: t.object({ id: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      mcp: { expose: true },
      handle: ({ input }) => ({ id: input.id }),
    }).named('plainMember');
    const fanOut = hive({
      input: t.object({}),
      member: plain,
      split: () => [{ id: 'a' }, { id: 'b' }],
      onMemberError: 'collect',
      policy: allow(),
    }).named('plainHive');
    const result = await fanOut({}, { ctx: ctxOf({ actor: userActor({ id: 'u-1' }) }) });
    expect(result.ok).toBe(2);
  });
});

describe('the org ceiling holds under concurrency', () => {
  // Every call roots its own ledger — one per request — so nothing in-process orders them: the
  // store's `take` is the only thing that can.
  test('N calls racing one org counter: exactly the ones that fit reach the provider', async () => {
    const estimate = await oneEstimate();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider: inner, seen } = stub(ANSWER);
    const holding: Provider = {
      ...inner,
      async generate(request) {
        const answer = inner.generate(request);
        await held;
        return answer;
      },
    };
    const { store } = recording();
    install(holding, { org: estimate * 2 + 1 }, store);
    const summarize = declare(promptFor());

    const runs = Array.from({ length: 8 }, (_, index) =>
      summarize({ postId: POST_ID }, { ctx: ctxFor(`u-${index}`, 'acme') }).then(
        () => 'ok' as const,
        (error: unknown) => (error as { code?: string }).code ?? 'unknown',
      ),
    );
    for (let tick = 0; tick < 500; tick += 1) await Promise.resolve();
    release();
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((one) => one === 'ok').length).toBe(2);
    expect(outcomes.filter((one) => one === 'X_AI_BUDGET_EXCEEDED').length).toBe(6);
    expect(seen.length).toBe(2);
  });

  test('a scope per request, one org key: the same answer through gateway.scope()', async () => {
    const store = memoryBudgetStore();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider: inner, seen } = stub(ANSWER);
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [
        {
          ...inner,
          async generate(request) {
            const answer = inner.generate(request);
            await held;
            return answer;
          },
        },
      ],
      budget: { org: 1_500 },
      budgetStore: store,
    });
    const runs = Array.from({ length: 8 }, () =>
      gateway
        .scope({ orgKey: 'org:acme' }, () =>
          gateway.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 1_000 }),
        )
        .then(
          () => 'ok' as const,
          () => 'refused' as const,
        ),
    );
    for (let tick = 0; tick < 500; tick += 1) await Promise.resolve();
    release();
    const outcomes = await Promise.all(runs);
    expect(outcomes.filter((one) => one === 'ok').length).toBe(1);
    expect(seen.length).toBe(1);
  });
});

// Every `llm()` / `agent()` / `hive()` now carries its caller's keys, so a store write per key
// would grow `MemoryBudgetStore` by one entry per caller forever — and cost a shared store two
// writes per call — in an app that declared no `actor` / `org` ceiling at all.
describe('a scope with no ceiling never touches the store', () => {
  test('N distinct callers, no budget declared: the store is empty and saw zero writes', async () => {
    const inner = memoryBudgetStore();
    const writes: string[] = [];
    const store: BudgetStore = {
      spent: (key) => inner.spent(key),
      reset: (key) => inner.reset(key),
      add(key, tokens) {
        writes.push(`add:${key}`);
        inner.add(key, tokens);
      },
      take(key, tokens, limit) {
        writes.push(`take:${key}`);
        return inner.take(key, tokens, limit);
      },
    };
    const { provider, seen } = stub(ANSWER);
    configureAi({
      gateway: providerGateway({
        defaultModel: FIXTURE_MODEL,
        providers: [provider],
        budgetStore: store,
      }),
    });
    const summarize = declare(promptFor());
    for (let index = 0; index < 20; index += 1) {
      await summarize({ postId: POST_ID }, { ctx: ctxFor(`u-${index}`, `org-${index}`) });
    }
    expect(seen.length).toBe(20);
    expect(writes).toEqual([]);
    expect(inner.size()).toBe(0);
  });

  test('a declared actor ceiling writes only the actor key, never the org one', async () => {
    const { store, inner } = recording();
    install(stub(ANSWER).provider, { actor: 1_000_000 }, store);
    await declare(promptFor())({ postId: POST_ID }, { ctx: ctxFor('u-1', 'acme') });
    expect(inner.spent('actor:user:u-1')).toBeGreaterThan(0);
    expect(inner.size()).toBe(1);
  });

  test('a counter that returns to zero is forgotten, not kept as an entry', () => {
    const store = memoryBudgetStore();
    store.add('actor:user:u-1', 50);
    store.add('actor:user:u-1', -50);
    expect(store.size()).toBe(0);
    expect(store.take('k', 10, 5)).toEqual({ taken: false, spent: 0 });
    expect(store.size()).toBe(0);
  });
});
