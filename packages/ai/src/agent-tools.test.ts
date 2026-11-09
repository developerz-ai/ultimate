/**
 * One model turn's tool calls are a bounded fan-out: a turn that asks for fifty calls — a confused
 * or prompt-injected model — runs at most `maxToolConcurrency` of them at once, and the results
 * still pair with their calls in the order the model emitted them.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { DEFAULT_TOOL_CONCURRENCY, runToolBatch } from './agent-tools';
import { echoProvider } from './echo-provider';
import { AiRequestInvalidError } from './errors';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { installAiGateway, resetAiRuntime } from './runtime';
import type { LlmToolCall, ProjectableAction } from './tools';

useFixtureModels();

const USAGE: TokenUsage = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** A tool that records how many of its runs overlap, and answers with its input's `n`. */
function counted() {
  const seen = { inFlight: 0, peak: 0 };
  const tool: ProjectableAction = {
    name: 'probe',
    description: 'probe',
    mcp: { expose: true },
    async run({ input }) {
      seen.inFlight += 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      // Later calls finish FIRST, so a result order that followed completion would be reversed.
      const n = (input as { n: number }).n;
      for (let turn = 0; turn < (n % 3 === 0 ? 3 : 1); turn += 1) await Promise.resolve();
      seen.inFlight -= 1;
      return `r${n}`;
    },
  };
  return { seen, tool };
}

const calls = (count: number): readonly LlmToolCall[] =>
  Array.from({ length: count }, (_, n) => ({ id: `c${n}`, name: 'probe', input: { n } }));

describe('runToolBatch()', () => {
  test('50 calls run at most 8 at a time, results in call order', async () => {
    const { seen, tool } = counted();
    const results = await runToolBatch([tool], calls(50), userActor({ id: 'u' }), {
      concurrency: DEFAULT_TOOL_CONCURRENCY,
    });
    expect(DEFAULT_TOOL_CONCURRENCY).toBe(8);
    expect(seen.peak).toBe(8);
    expect(results.map((one) => one.toolUseId)).toEqual(calls(50).map((call) => call.id));
    expect(results.map((one) => one.content)).toEqual(calls(50).map((_, n) => `"r${n}"`));
  });

  test('a call waiting for a slot never starts once the run was stopped', async () => {
    let ran = 0;
    let stopped = false;
    const tool: ProjectableAction = {
      name: 'probe',
      description: 'probe',
      mcp: { expose: true },
      run() {
        ran += 1;
        stopped = true;
        return Promise.resolve('ok');
      },
    };
    const batch = runToolBatch([tool], calls(10), userActor({ id: 'u' }), {
      concurrency: 1,
      beforeCall: () => {
        if (stopped) throw new AiRequestInvalidError({ detail: 'stopped', fix: 'none' });
      },
    });
    await expect(batch).rejects.toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(ran).toBe(1);
  });

  test('a concurrency of 1 is serial', async () => {
    const { seen, tool } = counted();
    await runToolBatch([tool], calls(5), userActor({ id: 'u' }), { concurrency: 1 });
    expect(seen.peak).toBe(1);
  });
});

describe('agent({ maxToolConcurrency })', () => {
  function oneTurnOf(count: number): Provider {
    let turn = 0;
    return {
      name: 'scripted',
      models: ['claude-opus-5'],
      generate(_request: GenerateRequest) {
        turn += 1;
        const toolCalls =
          turn === 1
            ? calls(count)
            : [{ id: `a${turn}`, name: 'respond', input: { answer: 'done' } }];
        return Promise.resolve({
          model: 'claude-opus-5',
          text: '',
          toolCalls,
          stopReason: 'tool_use',
          stopDetails: undefined,
          usage: USAGE,
          cost: costOf('claude-opus-5', USAGE),
        } satisfies GenerateResult);
      },
      stream: (request) => echoProvider().stream(request),
    };
  }

  const run = async (count: number, maxToolConcurrency?: number) => {
    resetAiRuntime();
    installAiGateway(
      providerGateway({ defaultModel: FIXTURE_MODEL, providers: [oneTurnOf(count)] }),
    );
    const { seen, tool } = counted();
    const fanned = agent({
      input: t.object({}),
      output: t.object({ answer: t.string }),
      prompt: definePrompt({
        id: `fan-${count}-${String(maxToolConcurrency)}`,
        version: '1.0.0',
        template: 'go',
      }),
      vars: () => ({}),
      tools: [tool],
      maxTurns: 3,
      ...(maxToolConcurrency === undefined ? {} : { maxToolConcurrency }),
      policy: allow(),
    }).named(`fanAgent${count}${String(maxToolConcurrency)}`);
    const answer = await fanned({}, { ctx: ctxOf({ actor: userActor({ id: 'u' }) }) });
    return { answer, peak: seen.peak };
  };

  test('a turn asking for 50 calls never has more than 8 in flight', async () => {
    const { answer, peak } = await run(50);
    expect(answer).toEqual({ answer: 'done' });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  test('the bound is the agent declaration’s to set', async () => {
    expect((await run(20, 2)).peak).toBe(2);
  });

  test('a tool declared for agents only is offered without being exposed', async () => {
    resetAiRuntime();
    installAiGateway(providerGateway({ defaultModel: FIXTURE_MODEL, providers: [oneTurnOf(1)] }));
    const { seen, tool } = counted();
    const agentsOnly: ProjectableAction = { ...tool, mcp: { expose: false, agents: true } };
    const fanned = agent({
      input: t.object({}),
      output: t.object({ answer: t.string }),
      prompt: definePrompt({ id: 'fan-agents-only', version: '1.0.0', template: 'go' }),
      vars: () => ({}),
      tools: [agentsOnly],
      policy: allow(),
    }).named('fanAgentAgentsOnly');
    await fanned({}, { ctx: ctxOf({ actor: userActor({ id: 'u' }) }) });
    expect(seen.peak).toBe(1);
  });

  test('a bound that is not a positive count fails the declaration', () => {
    expect(() =>
      agent({
        input: t.object({}),
        output: t.object({ answer: t.string }),
        prompt: definePrompt({ id: 'fan-bad', version: '1.0.0', template: 'go' }),
        vars: () => ({}),
        tools: [],
        maxToolConcurrency: 0,
        policy: allow(),
      }),
    ).toThrow(expect.objectContaining({ code: 'X_INVARIANT' }));
  });
});
