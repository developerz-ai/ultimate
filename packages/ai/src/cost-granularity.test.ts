/**
 * What a call cost, to the precision a provider bills at. Two failures first:
 *
 *   - a call worth a tenth of a cent read as TWO cents: the input half and the output half were
 *     each rounded up to a whole minor unit, per call, and a ledger summed those — so a 14-turn
 *     run of cheap turns reported four times what it cost;
 *   - a price below one minor unit per million tokens could not be stated at all: the row read
 *     `minor` and ignored `Money`'s own `scale`, so `$0.075` per million was either 7 or 8 cents,
 *     and a row that DID state a scale was priced ten times over.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import { BudgetLedger, withBudget } from './budget';
import { costOf, exactCostOf } from './cost';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { registerModel, resetModels } from './models';
import { definePrompt } from './prompt';
import type { GenerateResult, Provider, TokenUsage } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const usd = (minor: number, scale?: number) => ({
  minor,
  currency: 'USD',
  ...(scale === undefined ? {} : { scale }),
});
const ROW = {
  contextWindow: 1_000_000,
  maxOutput: 64_000,
  cacheMinimumTokens: 1_024,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
} as const;
const SONNET = 'vendor/sonnet';
const FLASH = 'vendor/flash-lite';
const usage = (input: number, output: number, read = 0, write = 0): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: read,
  cacheWriteTokens: write,
});

beforeEach(() => {
  resetModels();
  resetAiRuntime();
  // $2 in, $10 out, $0.10 read per million — whole cents, the shape every existing row has.
  registerModel({
    id: SONNET,
    ...ROW,
    inputPerMillion: usd(200),
    outputPerMillion: usd(1_000),
    cacheReadPerMillion: usd(10),
    cacheWritePerMillion: usd(250),
  });
  // $0.075 in, $0.30 out per million: 7.5 cents cannot be a whole `minor`, so the row says
  // `scale: 3` — thousandths of a dollar — which `Money` has always been able to carry.
  registerModel({
    id: FLASH,
    ...ROW,
    inputPerMillion: usd(75, 3),
    outputPerMillion: usd(300, 3),
  });
});

describe('one call is rounded up once', () => {
  test('a call worth 0.105 cents costs 1 cent, not 2', () => {
    // 150 × $2/M = 0.03¢, 75 × $10/M = 0.075¢. Rounded per half that was 1¢ + 1¢.
    expect(costOf(SONNET, usage(150, 75))).toEqual({ minor: 1, currency: 'USD' });
  });

  test('the exact figure is Money at a finer scale: micro-units of the minor unit', () => {
    // 0.105 cents is 105,000 millionths of a cent — `scale: 8` for a currency of exponent 2.
    expect(exactCostOf(SONNET, usage(150, 75))).toEqual({
      minor: 105_000,
      currency: 'USD',
      scale: 8,
    });
  });

  test('a whole-cent call is unchanged', () => {
    expect(costOf(SONNET, usage(1_000_000, 1_000_000))).toEqual({ minor: 1_200, currency: 'USD' });
    expect(costOf(SONNET, usage(0, 0))).toEqual({ minor: 0, currency: 'USD' });
  });

  test('the default cache multipliers stay exact: 0.1x read and 1.25x write of input', () => {
    registerModel({
      id: 'vendor/plain',
      ...ROW,
      inputPerMillion: usd(300),
      outputPerMillion: usd(1_500),
    });
    // 1M read at 0.1 × $3 = 30¢; 1M written at 1.25 × $3 = 375¢.
    expect(costOf('vendor/plain', usage(0, 0, 1_000_000, 0)).minor).toBe(30);
    expect(costOf('vendor/plain', usage(0, 0, 0, 1_000_000)).minor).toBe(375);
  });
});

describe('a price finer than a minor unit per million is a row', () => {
  test('$0.075 per million prices a million tokens at 7.5 cents', () => {
    expect(exactCostOf(FLASH, usage(1_000_000, 0))).toEqual({
      minor: 7_500_000,
      currency: 'USD',
      scale: 8,
    });
    // Rounded up, once: 8 cents — never the 75 a reader of `minor` alone would bill.
    expect(costOf(FLASH, usage(1_000_000, 0))).toEqual({ minor: 8, currency: 'USD' });
    expect(costOf(FLASH, usage(2_000_000, 1_000_000))).toEqual({ minor: 45, currency: 'USD' });
  });

  test('a scale finer than the cost can carry is refused at registration', () => {
    expect(() =>
      registerModel({
        id: 'vendor/too-fine',
        ...ROW,
        inputPerMillion: usd(1, 12),
        outputPerMillion: usd(1),
      }),
    ).toThrow('inputPerMillion');
  });
});

describe('a run is rounded once, at the end', () => {
  // One turn: 1,200 input at $2, 150 output at $10, 6,000 read at $0.10 per million
  //   = 0.24¢ + 0.15¢ + 0.06¢ = 0.45¢.
  const TURN = usage(1_200, 150, 6_000);
  const TURNS = 14;

  function scripted(): Provider {
    let calls = 0;
    return {
      name: 'scripted',
      models: [SONNET],
      generate() {
        calls += 1;
        const last = calls === TURNS;
        const result: GenerateResult = {
          model: SONNET,
          text: '',
          toolCalls: [
            last
              ? { id: `c${calls}`, name: 'respond', input: { answer: 'done' } }
              : { id: `c${calls}`, name: 'readDoc', input: { n: calls } },
          ],
          stopReason: 'tool_use',
          stopDetails: undefined,
          usage: TURN,
          cost: costOf(SONNET, TURN),
          costExact: exactCostOf(SONNET, TURN),
        };
        return Promise.resolve(result);
      },
      stream: (request) => echoProvider().stream(request),
    };
  }

  test('14 turns of 0.45 cents: the ledger and the run say 7 cents — it was 28', async () => {
    configureAi({ gateway: providerGateway({ providers: [scripted()], defaultModel: SONNET }) });
    const readDoc: ProjectableAction = {
      name: 'readDoc',
      description: 'Read one document',
      mcp: { expose: true },
      run: ({ input }) => Promise.resolve(`doc ${JSON.stringify(input)}`),
    };
    const turns: AgentTurn[] = [];
    const run = agent({
      input: t.object({ q: t.string }),
      output: t.object({ answer: t.string }),
      prompt: definePrompt<{ q: string }>({ id: 'fourteen', version: '1.0.0', template: '{{q}}' }),
      vars: ({ input }) => ({ q: input.q }),
      tools: [readDoc],
      policy: allow(),
      maxTurns: TURNS,
      onTurn: (event) => void turns.push(event),
    }).named('fourteenTurns');

    const ledger = new BudgetLedger({ limits: {} });
    const done = await withBudget(ledger, () =>
      run.run({ q: 'go' }, { ctx: ctxOf({ actor: userActor({ id: 'u' }) }) }),
    );

    // What the old arithmetic reported for this same run: each call's input half (0.30¢) and
    // output half (0.15¢) rounded up separately, then summed by the ledger.
    const before = TURNS * (Math.ceil(0.3) + Math.ceil(0.15));
    expect(before).toBe(28);

    const report = await ledger.report();
    expect(report.cost).toEqual({ minor: 7, currency: 'USD' });
    expect(report.costExact).toEqual({ minor: 6_300_000, currency: 'USD', scale: 8 });
    expect(done.usage.cost).toEqual({ minor: 7, currency: 'USD' });
    expect(done.usage.costExact).toEqual({ minor: 6_300_000, currency: 'USD', scale: 8 });
    // A turn alone still reads in whole minor units, rounded up — and exactly beside it.
    expect(turns).toHaveLength(TURNS);
    expect(turns[0]?.cost).toEqual({ minor: 1, currency: 'USD' });
    expect(turns[0]?.costExact).toEqual({ minor: 450_000, currency: 'USD', scale: 8 });
    expect(turns.at(-1)?.run.cost).toEqual({ minor: 7, currency: 'USD' });
  });

  test('a provider that reports no exact cost is summed from its rounded one', async () => {
    const ledger = new BudgetLedger({ limits: {} });
    await ledger.record(TURN, { minor: 1, currency: 'USD' });
    await ledger.record(TURN, { minor: 1, currency: 'USD' });
    expect((await ledger.report()).cost).toEqual({ minor: 2, currency: 'USD' });
  });
});
