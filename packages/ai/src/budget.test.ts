/**
 * The ledger's contract: it refuses BEFORE a call, it names the scope that refused, and a
 * derived ledger can only tighten what it was derived from. The last one is the load-bearing
 * one — a per-call budget declared on an `llm()` action must never be a way to widen the org
 * ceiling it runs inside, and nothing but this file proves that.
 */

import { describe, expect, test } from 'bun:test';
import type { BudgetStore } from './budget';
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
