/**
 * The ledger's contract: it refuses BEFORE a call, it names the scope that refused, and a
 * derived ledger can only tighten what it was derived from. The last one is the load-bearing
 * one — a per-call budget declared on an `llm()` action must never be a way to widen the org
 * ceiling it runs inside, and nothing but this file proves that.
 */

import { describe, expect, test } from 'bun:test';
import { NOT_A_BOUND, refusal } from './bounds-fixture';
import type { BudgetLimits, BudgetStore } from './budget';
import { BudgetLedger, estimateSpend, MemoryBudgetStore } from './budget';
import type { GenerateRequest } from './provider';

const usd = (minor: number) => ({ minor, currency: 'USD' });

const request = (text: string, maxTokens = 256): GenerateRequest => ({
  model: 'claude-opus-5',
  messages: [{ role: 'user', content: text }],
  maxTokens,
});

describe('the spend estimate', () => {
  test('prices the prompt and the WORST-CASE completion, not a hoped-for one', () => {
    const short = estimateSpend(request('hello', 100));
    const long = estimateSpend(request('hello', 10_000));
    expect(long.inputTokens).toBe(short.inputTokens);
    expect(long.tokens).toBeGreaterThan(short.tokens);
    // Same prompt, bigger ceiling: the price must move, or a ceiling buys nothing.
    expect(long.cost.minor).toBeGreaterThan(short.cost.minor);
    expect(Number.isInteger(long.cost.minor)).toBe(true);
  });

  test('input tokens exclude the completion, so tokensIn caps what the caller controls', () => {
    const estimate = estimateSpend(request('x'.repeat(400), 1_000));
    expect(estimate.tokens - estimate.inputTokens).toBe(1_000);
  });
});

describe('reserve refuses, naming the scope', () => {
  test('the request scope accumulates across calls on one ledger', async () => {
    const ledger = new BudgetLedger({ limits: { request: 5_000 } });
    await ledger.reserve(estimateSpend(request('hi', 1_000)));
    await ledger.record(
      { inputTokens: 4_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usd(3),
    );
    await expect(ledger.reserve(estimateSpend(request('hi', 1_000)))).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('"request"'),
    });
  });

  test('tokensIn caps the prompt alone — a big ceiling on output does not trip it', async () => {
    const ledger = new BudgetLedger({ limits: { tokensIn: 100 } });
    await ledger.reserve(estimateSpend(request('short', 50_000)));
    await expect(ledger.reserve(estimateSpend(request('x'.repeat(4_000))))).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('"tokensIn"'),
    });
  });

  test('costPerCall refuses in minor units and never as a float', async () => {
    const ledger = new BudgetLedger({ limits: { costPerCall: usd(2) } });
    await expect(ledger.reserve(estimateSpend(request('hi', 100_000)))).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('USD minor units'),
    });
  });

  test('a cost limit in another currency is a config bug, not a silent conversion', async () => {
    const ledger = new BudgetLedger({ limits: { costPerCall: { minor: 500, currency: 'EUR' } } });
    await expect(ledger.reserve(estimateSpend(request('hi')))).rejects.toMatchObject({
      code: 'X_CURRENCY_MISMATCH',
    });
  });

  test('nothing is debited by a refusal', async () => {
    const store = new MemoryBudgetStore();
    const ledger = new BudgetLedger({ limits: { actor: 10 }, actorKey: 'actor:u1', store });
    await expect(ledger.reserve(estimateSpend(request('hi')))).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
    });
    expect(store.spent('actor:u1')).toBe(0);
  });
});

describe('derive tightens, never widens', () => {
  test('a looser per-call limit cannot raise the ceiling it was derived from', async () => {
    const parent = new BudgetLedger({ limits: { tokensIn: 100, costPerCall: usd(5) } });
    const child = parent.derive({ tokensIn: 10_000, costPerCall: usd(9_999) });
    await expect(child.reserve(estimateSpend(request('x'.repeat(4_000))))).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('"tokensIn"'),
    });
  });

  test('a tighter per-call limit wins over a looser parent', async () => {
    const parent = new BudgetLedger({ limits: { tokensIn: 10_000 } });
    const child = parent.derive({ tokensIn: 5 });
    await expect(child.reserve(estimateSpend(request('x'.repeat(200))))).rejects.toMatchObject({
      cause: expect.stringContaining('"tokensIn"'),
    });
  });

  test('the identity keys and the store survive, so cross-request counters keep counting', async () => {
    const store = new MemoryBudgetStore();
    const parent = new BudgetLedger({ limits: { actor: 1_000 }, actorKey: 'actor:u1', store });
    const child = parent.derive({ costPerCall: usd(500) });

    // The reservation is handed to `record`, so the estimate it debited is reconciled away and
    // what remains is the provider's real count.
    const reservation = await child.reserve(estimateSpend(request('hi')));
    await child.record(
      { inputTokens: 900, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usd(1),
      reservation,
    );
    expect(store.spent('actor:u1')).toBe(950);
    await expect(child.reserve(estimateSpend(request('hi')))).rejects.toMatchObject({
      cause: expect.stringContaining('actor:u1'),
    });
  });

  // A derived ledger was a NEW ledger with `requestTokens` and `costMinor` at zero and no link
  // back, so every `llm()` call — each of which derives one — spent against a fresh counter. The
  // ambient ledger `gateway.scope()` installed saw none of it: `spent()` answered zero after a
  // hundred calls, and a `request` ceiling of 5,000 admitted 5,000 tokens per call, forever.
  test('a child debits the parent it was derived from', async () => {
    const parent = new BudgetLedger({ limits: {} });
    const child = parent.derive({});
    const usage = { inputTokens: 900, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };

    await child.record(usage, usd(7));

    const report = await parent.report();
    expect(report.requestTokens).toBe(950);
    expect(report.cost).toEqual(usd(7));
  });

  test('a grandchild reaches the whole chain, once each', async () => {
    const root = new BudgetLedger({ limits: {} });
    const child = root.derive({});
    const grandchild = child.derive({});
    const usage = { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    await grandchild.record(usage, usd(1));

    expect((await root.report()).requestTokens).toBe(10);
    expect((await child.report()).requestTokens).toBe(10);
    expect((await root.report()).cost).toEqual(usd(1));
  });

  test("the parent's request ceiling bounds its children together, not each apart", async () => {
    const parent = new BudgetLedger({ limits: { request: 5_000 } });
    const first = parent.derive({});
    const reservation = await first.reserve(estimateSpend(request('x'.repeat(4_000), 3_000)));
    expect(reservation.tokens).toBeGreaterThan(2_000);

    // A second call under the same scope: its own counter is empty, the parent's is not.
    const second = parent.derive({});
    await expect(
      second.reserve(estimateSpend(request('x'.repeat(4_000), 3_000))),
    ).rejects.toMatchObject({
      code: 'X_AI_BUDGET_EXCEEDED',
      cause: expect.stringContaining('"request"'),
    });
  });

  test('a release credits the whole chain back, so nothing is stranded', async () => {
    const parent = new BudgetLedger({ limits: { request: 5_000 } });
    const child = parent.derive({});
    const reservation = await child.reserve(estimateSpend(request('hi', 1_000)));
    expect((await parent.report()).requestTokens).toBeGreaterThan(0);

    await child.release(reservation);
    expect((await parent.report()).requestTokens).toBe(0);
  });

  test('the shared store is still credited exactly once per debit', async () => {
    const store = new MemoryBudgetStore();
    const parent = new BudgetLedger({ limits: {}, actorKey: 'actor:u1', orgKey: 'org:o1', store });
    const child = parent.derive({});

    await child.record(
      { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usd(1),
    );

    expect(store.spent('actor:u1')).toBe(100);
    expect(store.spent('org:o1')).toBe(100);
  });

  test('an unset scope on either side stays unset rather than defaulting to zero', async () => {
    const child = new BudgetLedger({ limits: {} }).derive({});
    await expect(child.reserve(estimateSpend(request('x'.repeat(100_000))))).resolves.toMatchObject(
      { tokens: expect.any(Number) },
    );
  });
});

describe('the ceiling holds under parallelism', () => {
  /** A store whose `spent` yields to the loop, so three reads can genuinely interleave. */
  function slowStore(): BudgetStore & { read(key: string): number } {
    const inner = new MemoryBudgetStore();
    return {
      async spent(key: string): Promise<number> {
        await Promise.resolve();
        return inner.spent(key);
      },
      add: (key, tokens) => inner.add(key, tokens),
      reset: (key) => inner.reset(key),
      read: (key) => inner.spent(key),
    };
  }

  // Measured: `budget: { actor: 10_000 }` and three concurrent calls estimating ~4k tokens each
  // all read `spent() === 0`, all passed, and 12k was recorded against a 10k ceiling.
  test('three concurrent reserves cannot all pass one actor ceiling', async () => {
    const store = slowStore();
    const ledger = new BudgetLedger({ limits: { actor: 10_000 }, actorKey: 'actor:u1', store });
    const call = () => ledger.reserve(estimateSpend(request('hi', 4_000)));

    const outcomes = await Promise.allSettled([call(), call(), call()]);

    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(store.read('actor:u1')).toBeLessThanOrEqual(10_000);
  });

  test('the same holds for the org ceiling', async () => {
    const store = slowStore();
    const ledger = new BudgetLedger({ limits: { org: 10_000 }, orgKey: 'org:o1', store });
    const call = () => ledger.reserve(estimateSpend(request('hi', 4_000)));

    const outcomes = await Promise.allSettled([call(), call(), call()]);

    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
    expect(store.read('org:o1')).toBeLessThanOrEqual(10_000);
  });

  // A refusal must not reject the reservations queued behind it on the turnstile.
  test('a refused reservation lets the next one through on its own merits', async () => {
    const store = slowStore();
    const ledger = new BudgetLedger({ limits: { actor: 10_000 }, actorKey: 'actor:u1', store });

    await expect(ledger.reserve(estimateSpend(request('hi', 20_000)))).rejects.toMatchObject({
      cause: expect.stringContaining('actor:u1'),
    });
    await expect(ledger.reserve(estimateSpend(request('hi', 100)))).resolves.toMatchObject({
      tokens: expect.any(Number),
    });
  });

  test('release gives an unspent reservation back in full', async () => {
    const store = new MemoryBudgetStore();
    const ledger = new BudgetLedger({ limits: { actor: 10_000 }, actorKey: 'actor:u1', store });

    const reservation = await ledger.reserve(estimateSpend(request('hi', 4_000)));
    expect(store.spent('actor:u1')).toBeGreaterThan(0);

    await ledger.release(reservation);
    expect(store.spent('actor:u1')).toBe(0);
  });

  test('record reconciles down to the real count, never on top of the estimate', async () => {
    const store = new MemoryBudgetStore();
    const ledger = new BudgetLedger({ limits: { actor: 10_000 }, actorKey: 'actor:u1', store });

    const reservation = await ledger.reserve(estimateSpend(request('hi', 4_000)));
    await ledger.record(
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usd(1),
      reservation,
    );

    expect(store.spent('actor:u1')).toBe(15);
  });
});

/**
 * A ceiling that is not a number does not become a wrong ceiling — it stops being one.
 *
 * `assertScope` asks `want > limit - spent`, and every comparison against a `NaN` is false, so the
 * scope is silently unlimited while `report()`, a log line and a manifest row all still show a
 * declared ceiling. Measured before this screen: a 5,000,000-token call passed a `request` limit
 * of `NaN` outright. Screened in the constructor, which `derive` also goes through.
 */
describe('the ledger refuses a ceiling that cannot hold', () => {
  /** One builder per scope, written out: a computed key would give up the type this file checks. */
  const LIMIT = {
    request: (request: number): BudgetLimits => ({ request }),
    tokensIn: (tokensIn: number): BudgetLimits => ({ tokensIn }),
    actor: (actor: number): BudgetLimits => ({ actor }),
    org: (org: number): BudgetLimits => ({ org }),
  };

  test('every scope is named, and the honest ones are untouched', () => {
    for (const [scope, limits] of Object.entries(LIMIT)) {
      for (const value of NOT_A_BOUND) {
        const error = refusal(() => new BudgetLedger({ limits: limits(value) }));
        expect(error.code).toBe('X_INVARIANT');
        expect(error.cause).toContain(scope);
      }
    }
    // An ABSENT limit is "unlimited" by design and stays absent — the screen is about a declared
    // one, which is exactly why a `NaN` was the dangerous value: it reads as declared.
    expect(() => new BudgetLedger({ limits: {} })).not.toThrow();
    expect(() => new BudgetLedger({ limits: { request: 0 } })).not.toThrow();
  });

  test('a derived ledger is screened by the same constructor it is built through', async () => {
    const parent = new BudgetLedger({ limits: { request: 1_000 } });
    expect(refusal(() => parent.derive({ tokensIn: Number.NaN })).cause).toContain('tokensIn');
    // And the honest derivation still tightens, which is the rule this file exists for.
    expect((await parent.derive({ request: 100 }).report()).limits.request).toBe(100);
  });
});
