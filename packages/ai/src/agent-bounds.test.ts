/**
 * The agent loop's numeric bounds, in their own file because `agent.test.ts` is at the 500-line
 * ceiling and because this is one question: what happens when a ceiling is not a number.
 *
 * Nothing this file asserts is about the loop's behaviour, which is that file's subject — every
 * test here is about a run that must NOT start.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { asyncRefusal, NOT_A_BOUND, refusal } from './bounds-fixture';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

const Input = t.object({ orderId: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** One turn that answers straight away — enough for the honest half, and nothing more. */
function answering(): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'answering',
    models: ['claude-opus-5'],
    generate(request) {
      seen.push(request);
      const result: GenerateResult = {
        model: 'claude-opus-5',
        text: '',
        toolCalls: [{ id: 'call-1', name: 'respond', input: { answer: 'ok' } }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      };
      return Promise.resolve(result);
    },
    stream: (request) => new EchoProvider().stream(request),
  };
  return { provider, seen };
}

let seq = 0;
function promptFor(): Prompt<{ orderId: string }> {
  seq += 1;
  return definePrompt<{ orderId: string }>({
    id: `bounded-support-${seq}`,
    version: '1.0.0',
    template: 'Resolve order {{orderId}}.',
  });
}

const ctxAs = (id: string) => createContext({ actor: userActor({ id }) });

beforeEach(() => {
  resetAiRuntime();
});

/**
 * The three loop bounds, refused at DECLARATION — where the app wrote them, and where an `agent()`
 * evaluated at module scope makes a wrong one a boot failure rather than a ninetieth-second one.
 *
 * None of the three is checked by what it lands on, and each fails as something other than an
 * error: `turn <= NaN` is false on the FIRST comparison, so the loop takes zero turns and raises
 * `X_AGENT_MAX_TURNS` about a model that was never called; `slice(0, NaN)` is `''`, so every tool
 * result reaches the model empty while the run keeps paying for turns; and `maxTokens` becomes the
 * pre-flight estimate, where a `NaN` disables every budget ceiling in the process rather than
 * exceeding one.
 */
describe('agent() screens its loop bounds at declaration', () => {
  const declare = (extra: {
    maxTurns?: number;
    maxToolResultChars?: number;
    maxTokens?: number;
  }): (() => unknown) => {
    const prompt = promptFor();
    return () =>
      agent({
        input: Input,
        output: Output,
        prompt,
        vars: ({ input }) => ({ orderId: input.orderId }),
        tools: [],
        policy: allow(),
        ...extra,
      });
  };

  test('maxTurns, maxToolResultChars and maxTokens are each refused under their own name', () => {
    for (const value of NOT_A_BOUND) {
      expect(refusal(declare({ maxTurns: value })).cause).toContain('maxTurns');
      expect(refusal(declare({ maxToolResultChars: value })).cause).toContain('maxToolResultChars');
      expect(refusal(declare({ maxTokens: value })).cause).toContain('maxTokens');
    }
    const error = refusal(declare({ maxTurns: Number.NaN }));
    expect(error.code).toBe('X_INVARIANT');
    expect(error.fix).toContain('agent');
  });

  test('zero is refused too, because each of the three zeroes is a run that cannot answer', () => {
    // A loop of zero turns never calls the model and then reports X_AGENT_MAX_TURNS; a tool result
    // truncated to zero characters reaches the model empty; a completion ceiling of zero tokens
    // cannot carry an answer. None of the three is a setting, so the floor is 1 for all of them.
    expect(refusal(declare({ maxTurns: 0 })).cause).toContain('at least 1');
    expect(refusal(declare({ maxToolResultChars: 0 })).cause).toContain('at least 1');
    expect(refusal(declare({ maxTokens: 0 })).cause).toContain('at least 1');
  });

  test("the declared budget is screened under the declaration's key names", async () => {
    // `tokensPerRun` reaches `BudgetLimits` as `request`, so the ledger's own backstop would name
    // a key this app never wrote. Read through `limitsOf` on the first run, so the refusal comes
    // out of the call rather than the declaration — and before the gateway is even resolved.
    const perRun = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
      budget: { tokensPerRun: Number.NaN },
    }).named('budgetBoundAgent');
    const error = await asyncRefusal(() => perRun({ orderId: 'o-1' }, { ctx: ctxAs('user-1') }));
    expect(error.cause).toContain('tokensPerRun');
  });

  test('an honest declaration still loops — the non-vacuity half', async () => {
    const { provider, seen } = answering();
    configureAi({ gateway: createGateway({ providers: [provider] }) });
    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
      maxTurns: 2,
      maxToolResultChars: 100,
      maxTokens: 256,
    }).named('boundedAgent');
    expect(await support({ orderId: 'o-1' }, { ctx: ctxAs('user-1') })).toEqual({ answer: 'ok' });
    expect(seen[0]?.maxTokens).toBe(256);
  });
});
