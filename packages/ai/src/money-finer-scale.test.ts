/**
 * A cost stated FINER than the ledger carries. The failure first: `bookableCost` kept any integer
 * `scale`, and the ledger widened it with `minorAt` — which only widens. A provider (or a billed
 * failure) reporting twelve decimal places made the conversion throw after the provider was paid:
 * a streamed answer was lost before it was yielded, and a billed failure was REPLACED by the
 * conversion error with its reservation unsettled. A finer cost is rounded up to the ledger's
 * scale, in bigint.
 */

import { describe, expect, test } from 'bun:test';
import { LlmToolArgumentsError } from './answer-errors';
import { BudgetLedger, withBudget } from './budget';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import type { GenerateRequest, GenerateResult, Provider, StreamChunk } from './provider';

useFixtureModels();
const USAGE = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
// $0.000001234567 — twelve places; the ledger carries eight for USD.
const FINE = { minor: 1_234_567, currency: 'USD', scale: 12 };
const request: GenerateRequest = {
  model: FIXTURE_MODEL,
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 100,
};
const answer: GenerateResult = {
  model: FIXTURE_MODEL,
  text: 'paid for',
  toolCalls: [],
  stopReason: 'end_turn',
  stopDetails: undefined,
  usage: USAGE,
  cost: { minor: 1, currency: 'USD' },
  costExact: FINE,
};
const over = (provider: Partial<Provider>) =>
  providerGateway({
    defaultModel: FIXTURE_MODEL,
    providers: [
      {
        name: 'app-written',
        models: [FIXTURE_MODEL],
        generate: () => Promise.resolve(answer),
        stream: (r) => echoProvider().stream(r),
        ...provider,
      },
    ],
  });
// 0.0001234567 cents is 123.4567 millionths of a cent: rounded UP to 124.
const ROUNDED = { minor: 124, currency: 'USD', scale: 8 };

describe('a cost finer than the ledger carries is rounded up, never a throw', () => {
  test('a streamed done chunk is still yielded, and booked', async () => {
    const ledger = new BudgetLedger({ limits: {} });
    const seen: StreamChunk[] = [];
    await withBudget(ledger, async () => {
      const stream = over({
        stream: () =>
          (async function* (): AsyncGenerator<StreamChunk> {
            yield { type: 'done', result: answer };
          })(),
      }).stream(request);
      for await (const chunk of stream) seen.push(chunk);
    });
    expect(seen.at(-1)).toMatchObject({ type: 'done', result: { text: 'paid for' } });
    const report = await ledger.report();
    expect(report.costExact).toEqual(ROUNDED);
    expect(report.requestTokens).toBe(150);
  });

  test('a billed failure stays the failure it was, and its bill is recorded', async () => {
    const ledger = new BudgetLedger({ limits: {} });
    const thrown = new LlmToolArgumentsError({
      provider: 'app-written',
      model: FIXTURE_MODEL,
      tool: 'respond',
      chars: 9,
      billed: { usage: USAGE, cost: FINE, calls: 1, unsettled: 0 },
    });
    const outcome = await withBudget(ledger, () =>
      over({ generate: () => Promise.reject(thrown) }).generate(request),
    ).catch((error: unknown) => error);
    expect(outcome).toBe(thrown);
    const report = await ledger.report();
    expect(report.costExact).toEqual(ROUNDED);
    expect(report.requestTokens).toBe(150);
  });

  test('a ceiling and an estimate at different scales are reported at ONE scale', async () => {
    // $0.50 in thousandths against a $2.50 estimate in cents.
    const ledger = new BudgetLedger({
      limits: { costPerCall: { minor: 500, currency: 'USD', scale: 3 } },
    });
    const outcome = await withBudget(ledger, () =>
      over({}).generate({ ...request, maxTokens: 100_000 }),
    ).catch((error: unknown) => error as { code: string; cause: string });
    expect(outcome).toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    const cause = (outcome as { cause: string }).cause;
    // Thousandths of a dollar on both sides: 2,5xx requested, 500 left of 500.
    expect(cause).toMatch(/needs 25\d\d USD at scale 3/);
    expect(cause).toContain('has 500 of 500 left');
  });
});
