/**
 * A failure after the provider answered is not free, and an unattended job has to be able to say
 * what it cost. Two properties, for every such failure: the LEDGER holds what was billed, and the
 * thrown error's `meta.billed` carries it — the calls that answered, summed, and a count of the
 * calls that were started and never reported usage, whose bill cannot be known.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { LlmToolArgumentsError } from './answer-errors';
import type { Billed } from './billed';
import { billedOf } from './billed';
import { BudgetLedger, withBudget } from './budget';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, StopReason, TokenUsage } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

useFixtureModels();

const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
const PER_CALL = 1_200;

type Step =
  | { readonly call: string; readonly input?: Record<string, unknown>; readonly stop?: StopReason }
  | { readonly hang: true }
  | { readonly broken: true };

/** Turn N answers `steps[N-1]` (the last one repeats). */
function model(...steps: readonly Step[]): { seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: [FIXTURE_MODEL],
    generate(request) {
      const step = steps[Math.min(seen.length, steps.length - 1)];
      seen.push(request);
      if (step === undefined || 'hang' in step) {
        return new Promise((_, reject) => {
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason));
        });
      }
      const cost = costOf(FIXTURE_MODEL, USAGE);
      if ('broken' in step) {
        return Promise.reject(
          new LlmToolArgumentsError({
            provider: 'scripted',
            model: FIXTURE_MODEL,
            tool: 'respond',
            chars: 40,
            billed: { usage: USAGE, cost, calls: 1, unsettled: 0 },
          }),
        );
      }
      const result: GenerateResult = {
        model: FIXTURE_MODEL,
        text: '',
        toolCalls: [{ id: `call-${seen.length}`, name: step.call, input: step.input ?? {} }],
        stopReason: step.stop ?? 'tool_use',
        stopDetails:
          step.stop === 'refusal'
            ? { type: 'refusal', category: 'cyber', explanation: undefined }
            : undefined,
        usage: USAGE,
        cost,
      };
      return Promise.resolve(result);
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  configureAi({ gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }) });
  return { seen };
}

const Input = t.object({ topic: t.string });
const Output = t.object({ title: t.string });
let seq = 0;
const promptFor = () => {
  seq += 1;
  return definePrompt<{ topic: string }>({
    id: `billed-${seq}`,
    version: '1.0.0',
    template: 'Write about {{topic}}.',
  });
};

const ticking: ProjectableAction = (() => {
  let n = 0;
  return {
    name: 'readDoc',
    description: 'Read one document',
    mcp: { expose: true },
    run: () => Promise.resolve(`page ${++n}`),
  };
})();
const constant: ProjectableAction = { ...ticking, run: () => Promise.resolve('same') };

function declareLlm() {
  return llm({
    input: Input,
    output: Output,
    prompt: promptFor(),
    vars: ({ input }) => ({ topic: input.topic }),
    policy: allow(),
  }).named(`billedLlm${seq}`);
}

function declareAgent(
  extra: { deadlineMs?: number; maxTurns?: number; tool?: ProjectableAction } = {},
) {
  return agent({
    input: Input,
    output: Output,
    prompt: promptFor(),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [extra.tool ?? ticking],
    policy: allow(),
    maxTurns: extra.maxTurns ?? 4,
    ...(extra.deadlineMs === undefined ? {} : { deadlineMs: extra.deadlineMs }),
  }).named(`billedAgent${seq}`);
}

/** Run under a fresh ledger; hand back the failure, its bill, and what the ledger recorded. */
async function failing(
  run: (ctx: ReturnType<typeof ctxOf>) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<{ code: string; billed: Billed | undefined; ledgerTokens: number }> {
  const ledger = new BudgetLedger({ limits: {} });
  const ctx = ctxOf({
    actor: userActor({ id: 'u-1' }),
    ...(signal === undefined ? {} : { signal }),
  });
  const error = await withBudget(ledger, () => run(ctx)).then(
    () => expect.unreachable('the run was meant to fail'),
    (thrown: unknown) => thrown,
  );
  return {
    code: (error as { code: string }).code,
    billed: billedOf(error),
    ledgerTokens: (await ledger.report()).requestTokens,
  };
}

const bill = (calls: number, unsettled = 0) => ({
  usage: { inputTokens: 1_000 * calls, outputTokens: 200 * calls },
  calls,
  unsettled,
});

beforeEach(() => {
  resetAiRuntime();
});

describe('llm(): every failure after the provider answered carries its bill', () => {
  test('a truncated answer', async () => {
    model({ call: 'respond', stop: 'max_tokens' });
    const write = declareLlm();
    const outcome = await failing((ctx) => write({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_TRUNCATED');
    expect(outcome.billed).toMatchObject(bill(1));
    expect(outcome.ledgerTokens).toBe(PER_CALL);
  });

  test('a refusal', async () => {
    model({ call: 'respond', stop: 'refusal' });
    const write = declareLlm();
    const outcome = await failing((ctx) => write({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_REFUSED');
    expect(outcome.billed).toMatchObject(bill(1));
  });

  test('an answer and a repair turn that both fail the schema — two calls, both billed', async () => {
    model({ call: 'respond', input: { wrong: true } });
    const write = declareLlm();
    const outcome = await failing((ctx) => write({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_OUTPUT_INVALID');
    expect(outcome.billed).toMatchObject(bill(2));
    expect(outcome.billed?.cost).toEqual(
      costOf(FIXTURE_MODEL, { ...USAGE, inputTokens: 2_000, outputTokens: 400 }),
    );
    expect(outcome.ledgerTokens).toBe(2 * PER_CALL);
  });

  test('tool arguments that are not JSON on the repair turn: the first call is in the bill too', async () => {
    model({ call: 'respond', input: { wrong: true } }, { broken: true });
    const write = declareLlm();
    const outcome = await failing((ctx) => write({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_TOOL_ARGUMENTS_INVALID');
    expect(outcome.billed).toMatchObject(bill(2));
    expect(outcome.ledgerTokens).toBe(2 * PER_CALL);
  });
});

describe('agent(): the bill is the whole run so far', () => {
  test('the turn ceiling', async () => {
    model({ call: 'readDoc' });
    const run = declareAgent({ maxTurns: 3 });
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_AGENT_MAX_TURNS');
    expect(outcome.billed).toMatchObject(bill(3));
    expect(outcome.ledgerTokens).toBe(3 * PER_CALL);
  });

  test('a tool loop', async () => {
    model({ call: 'readDoc' });
    const run = declareAgent({ maxTurns: 8, tool: constant });
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_AGENT_TOOL_LOOP');
    expect(outcome.billed).toMatchObject(bill(3));
  });

  test('schema repair exhausted', async () => {
    model({ call: 'respond', input: { wrong: true } });
    const run = declareAgent({ maxTurns: 2 });
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_OUTPUT_INVALID');
    expect(outcome.billed).toMatchObject(bill(2));
  });

  test('a truncated turn after two tool turns', async () => {
    model({ call: 'readDoc' }, { call: 'readDoc' }, { call: 'respond', stop: 'max_tokens' });
    const run = declareAgent();
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_TRUNCATED');
    expect(outcome.billed).toMatchObject(bill(3));
    expect(outcome.ledgerTokens).toBe(3 * PER_CALL);
  });

  test('unparseable arguments on turn two: one earlier turn plus the failed call', async () => {
    model({ call: 'readDoc' }, { broken: true });
    const run = declareAgent();
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_LLM_TOOL_ARGUMENTS_INVALID');
    expect(outcome.billed).toMatchObject(bill(2));
    expect(outcome.ledgerTokens).toBe(2 * PER_CALL);
  });
});

describe('a call that never reported usage is counted, never priced', () => {
  test('the deadline passes during turn two: one turn billed, one call unsettled', async () => {
    model({ call: 'readDoc' }, { hang: true });
    const run = declareAgent({ deadlineMs: 40 });
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    expect(outcome.code).toBe('X_AGENT_DEADLINE');
    expect(outcome.billed).toMatchObject(bill(1, 1));
    // The reservation of the aborted call is given back: its bill is unknown, not estimated.
    expect(outcome.ledgerTokens).toBe(PER_CALL);
  });

  test('the caller leaves during the first call: nothing known, one call unsettled', async () => {
    model({ hang: true });
    const run = declareAgent();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }), controller.signal);
    expect(outcome.code).toBe('X_ABORTED');
    expect(outcome.billed).toMatchObject(bill(0, 1));
    expect(outcome.ledgerTokens).toBe(0);
  });

  test('a failure before any provider call carries no bill at all', async () => {
    model({ call: 'respond', input: { title: 'x' } });
    const run = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: () => {
        throw new LlmToolArgumentsError({
          provider: 'p',
          model: 'm',
          tool: 't',
          chars: 1,
          billed: { usage: USAGE, cost: { minor: 1, currency: 'USD' }, calls: 1, unsettled: 0 },
        });
      },
      tools: [ticking],
      policy: allow(),
    }).named(`billedBeforeAnyCall${seq}`);
    const outcome = await failing((ctx) => run({ topic: 'tides' }, { ctx }));
    // The error's own bill is left exactly as it was thrown — the run added nothing to it.
    expect(outcome.billed).toMatchObject({ calls: 1, unsettled: 0 });
  });
});
