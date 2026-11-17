// A budget store that throws while the gateway books a PAID call: the reservation goes back whole,
// and neither the in-memory `request` counter nor any store counter is left below zero — a negative
// ledger is a ceiling that admits more than it declares. `gateway-budget.test.ts` owns the rest.

import { describe, expect, test } from 'bun:test';
import type { BudgetLedger, BudgetStore } from './budget';
import { currentBudget } from './budget';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_ANTHROPIC_IDS, FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { Provider } from './provider';

useFixtureModels();

const echo = echoProvider();

/** Real usage far under the `maxTokens` estimate, as every real call is: 20 against 4 000. */
const short: Provider = {
  name: 'short',
  models: FIXTURE_ANTHROPIC_IDS,
  async generate(request) {
    const result = await echo.generate(request);
    return { ...result, usage: { ...result.usage, inputTokens: 10, outputTokens: 10 } };
  },
  async *stream(request) {
    for await (const chunk of echo.stream(request)) {
      if (chunk.type !== 'done') {
        yield chunk;
        continue;
      }
      const usage = { ...chunk.result.usage, inputTokens: 10, outputTokens: 10 };
      yield { type: 'done', result: { ...chunk.result, usage } };
    }
  },
};

/** A counter store whose next `add` on `failKey` throws once, armed by the test. */
function flakyStore(): {
  store: BudgetStore;
  counters: Map<string, number>;
  arm(key: string): void;
} {
  const counters = new Map<string, number>();
  let failKey: string | undefined;
  const store: BudgetStore = {
    spent: (key) => counters.get(key) ?? 0,
    add(key, tokens) {
      if (key === failKey) {
        failKey = undefined;
        // Handed TO the subject, never this test's own verdict.
        return Promise.reject(new TypeError('redis: connection reset'));
      }
      counters.set(key, (counters.get(key) ?? 0) + tokens);
      return undefined;
    },
    take(key, tokens, limit) {
      const spent = counters.get(key) ?? 0;
      if (spent + tokens > limit) return { taken: false, spent };
      counters.set(key, spent + tokens);
      return { taken: true, spent };
    },
    reset: () => counters.clear(),
  };
  return { store, counters, arm: (key) => (failKey = key) };
}

const ACTOR = 'actor:u1';
const ORG = 'org:acme';

describe('a store that throws while booking a paid call', () => {
  test('generate: the reservation goes back whole, the request counter never negative', async () => {
    const { store, counters, arm } = flakyStore();
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [short],
      budget: { request: 10_000, actor: 10_000 },
      budgetStore: store,
    });
    let ledger: BudgetLedger | undefined;
    await gateway.scope({ actorKey: ACTOR }, async () => {
      ledger = currentBudget();
      arm(ACTOR); // the reservation's `take` is unaffected; the record's `add` throws
      await gateway.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4_000 });
    });
    const report = await (ledger as BudgetLedger).report();
    expect(report.requestTokens).toBe(0);
    expect(counters.get(ACTOR)).toBe(0);
  });

  test('stream: a failed `done` record leaves both counters at zero', async () => {
    const { store, counters, arm } = flakyStore();
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [short],
      budget: { request: 10_000, actor: 10_000 },
      budgetStore: store,
    });
    let ledger: BudgetLedger | undefined;
    const run = gateway.scope({ actorKey: ACTOR }, async () => {
      ledger = currentBudget();
      for await (const chunk of gateway.stream({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4_000,
      })) {
        if (chunk.type === 'text') arm(ACTOR);
      }
    });
    await expect(run).rejects.toThrow(/connection reset/);
    const report = await (ledger as BudgetLedger).report();
    expect(report.requestTokens).toBe(0);
    expect(counters.get(ACTOR)).toBe(0);
  });

  test('a write that lands on one scope and fails on the next is undone, not doubled', async () => {
    const { store, counters, arm } = flakyStore();
    const gateway = providerGateway({
      defaultModel: FIXTURE_MODEL,
      providers: [short],
      budget: { actor: 10_000, org: 10_000 },
      budgetStore: store,
    });
    await gateway.scope({ actorKey: ACTOR, orgKey: ORG }, async () => {
      arm(ORG); // the actor's reconcile lands, the org's throws
      await gateway.generate({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 4_000 });
    });
    // Released whole on both: the actor's landed reconcile is taken back before the release, so
    // the release does not credit it a second time below zero.
    expect(counters.get(ACTOR)).toBe(0);
    expect(counters.get(ORG)).toBe(0);
  });
});
