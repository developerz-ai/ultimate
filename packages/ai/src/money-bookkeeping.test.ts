/**
 * Money that crosses a boundary this package does not own. Three failures first:
 *   - a `Provider` an app wrote returned `cost: { minor: 1.5 }` — legal until the ledger went
 *     exact — and `BigInt(1.5)` threw a raw RangeError AFTER the provider was paid, outside the
 *     `try`, so the answer was lost and the reservation never given back;
 *   - a `budget.costPerCall` stated at a finer `scale` was compared by `minor` alone, so a $0.50
 *     ceiling written `{ minor: 500, scale: 3 }` accepted a $4.00 estimate;
 *   - `billedOf` dropped a cost's `scale`, so an exact cost read back a million times too large.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { BILLED_META, billedOf } from './billed';
import { BudgetLedger, withBudget } from './budget';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';

useFixtureModels();
const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const request: GenerateRequest = {
  model: FIXTURE_MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};
const answer = (minor: number): GenerateResult => ({
  model: FIXTURE_MODEL,
  text: 'paid for',
  toolCalls: [],
  stopReason: 'end_turn',
  stopDetails: undefined,
  usage: USAGE,
  cost: { minor, currency: 'USD' },
});
const appProvider = (minor: number, stream?: () => AsyncIterable<StreamChunk>): Provider => ({
  name: 'app-written',
  models: [FIXTURE_MODEL],
  generate: () => Promise.resolve(answer(minor)),
  stream: stream ?? ((r) => echoProvider().stream(r)),
});
const gatewayOver = (provider: Provider) =>
  providerGateway({ providers: [provider], defaultModel: FIXTURE_MODEL });

let ledger: BudgetLedger;
beforeEach(() => {
  ledger = new BudgetLedger({ limits: {} });
});

describe("a provider's cost is the app's number", () => {
  test('a fractional minor is rounded up and booked — the paid answer is returned', async () => {
    const result = await withBudget(ledger, () => gatewayOver(appProvider(1.5)).generate(request));
    expect(result.text).toBe('paid for');
    const report = await ledger.report();
    expect(report.cost).toEqual({ minor: 2, currency: 'USD' });
    // Settled against the real usage: the reservation is not still held.
    expect(report.requestTokens).toBe(150);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -3])(
    'a cost of %p is booked as nothing, never as a throw and never as a credit',
    async (minor) => {
      const result = await withBudget(ledger, () =>
        gatewayOver(appProvider(minor)).generate(request),
      );
      expect(result.text).toBe('paid for');
      const report = await ledger.report();
      expect(report.cost).toEqual({ minor: 0, currency: 'USD' });
      expect(report.requestTokens).toBe(150);
    },
  );

  test('a stream whose provider throws AFTER its done chunk is settled once, not credited twice', async () => {
    // A stream that delivers `done` and then FAILS — the failure is this test's input.
    const provider = appProvider(1, () => ({
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next(): Promise<IteratorResult<StreamChunk>> {
            if (sent) return Promise.reject(new TypeError('socket closed late'));
            sent = true;
            return Promise.resolve({ done: false, value: { type: 'done', result: answer(1) } });
          },
        };
      },
    }));
    const outcome = await withBudget(ledger, async () => {
      for await (const _chunk of gatewayOver(provider).stream(request)) {
        // drain
      }
    }).catch((error: unknown) => error);
    expect(String(outcome)).toContain('socket closed late');
    // The call was recorded at its real usage; a second release would drive this below 150.
    expect((await ledger.report()).requestTokens).toBe(150);
  });
});

describe('budget.costPerCall is compared as money, at whatever scale it was written', () => {
  // The estimate for `request` on the fixture model is a few cents at most.
  const dear = { ...request, maxTokens: 100_000 };

  test('a ceiling at a finer scale refuses an estimate above it', async () => {
    // $0.50, written in thousandths. The estimate is $2.50 (100,000 tokens at $25 per million):
    // 250 cents — under `500` read as cents, five times over it read as what it says.
    const tight = new BudgetLedger({
      limits: { costPerCall: { minor: 500, currency: 'USD', scale: 3 } },
    });
    await expect(
      withBudget(tight, () => gatewayOver(appProvider(1)).generate(dear)),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
  });

  test('and one that is ample at a finer scale accepts it', async () => {
    // $500 written in millionths: `minor` alone is 50 billion "cents" either way — the other
    // direction is a small minor at a COARSER reading; both must agree with the dollars.
    const ample = new BudgetLedger({
      limits: { costPerCall: { minor: 500_000_000, currency: 'USD', scale: 6 } },
    });
    const result = await withBudget(ample, () => gatewayOver(appProvider(1)).generate(dear));
    expect(result.text).toBe('paid for');
  });

  test('derive() keeps the tighter of two ceilings in DOLLARS', async () => {
    // $0.50 at scale 3 is tighter than $4.00 at the currency scale, though 500 > 400.
    const parent = new BudgetLedger({ limits: { costPerCall: { minor: 400, currency: 'USD' } } });
    const child = parent.derive({ costPerCall: { minor: 500, currency: 'USD', scale: 3 } });
    expect((await child.report()).limits.costPerCall).toEqual({
      minor: 500,
      currency: 'USD',
      scale: 3,
    });
  });
});

describe('billedOf', () => {
  test("carries a cost's scale: an exact cost is not read back a million times over", () => {
    const error = new UltimateError({
      code: 'X_LLM_TRUNCATED',
      cause: 'c',
      fix: 'maxTokens: 2',
      meta: {
        [BILLED_META]: {
          usage: USAGE,
          cost: { minor: 105_000, currency: 'USD', scale: 8 },
          calls: 1,
          unsettled: 0,
        },
      },
    });
    expect(billedOf(error)?.cost).toEqual({ minor: 105_000, currency: 'USD', scale: 8 });
  });
});
