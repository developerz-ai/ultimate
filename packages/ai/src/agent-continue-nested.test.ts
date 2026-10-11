/**
 * A continuation belongs to ONE agent. The failure first: the session rode the async context, so
 * an agent called as a tool inside `outer.continue()` read the OUTER session, screened the outer
 * transcript as its own, and answered `X_AGENT_TRANSCRIPT_INVALID … written by agent "outer"`.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { inProcessTool } from './in-process-tool';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';

useFixtureModels();
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Answers by what the request is FOR: the inner agent always answers; the outer follows a script. */
function model(outer: readonly ('ask' | 'answer')[]): { seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  let step = 0;
  const provider: Provider = {
    name: 'scripted',
    models: [FIXTURE_MODEL],
    generate(request) {
      seen.push(request);
      const inner = !(request.tools ?? []).some((tool) => tool.name === 'askInner');
      const move = inner ? 'answer' : (outer[step++] ?? 'answer');
      const result: GenerateResult = {
        model: FIXTURE_MODEL,
        text: '',
        toolCalls: [
          move === 'ask'
            ? { id: `c${seen.length}`, name: 'askInner', input: { q: 'x' } }
            : { id: `c${seen.length}`, name: 'respond', input: { a: inner ? 'inner' : 'outer' } },
        ],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf(FIXTURE_MODEL, USAGE),
      };
      return Promise.resolve(result);
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  configureAi({ gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }) });
  return { seen };
}

const IO = { input: t.object({ q: t.string }), output: t.object({ a: t.string }) };
const prompt = (id: string) =>
  definePrompt<{ q: string }>({ id, version: '1.0.0', template: '{{q}}' });
const ctx = () => ctxOf({ actor: userActor({ id: 'u' }) });

describe('a continue session is the agent it was opened for, and nobody else', () => {
  test('outer.continue() → a tool that runs another agent: the inner one starts fresh', async () => {
    const inner = agent({
      ...IO,
      prompt: prompt('nested-inner'),
      vars: ({ input }) => ({ q: input.q }),
      tools: [],
      policy: allow(),
    }).named('nestedInner');
    const results: unknown[] = [];
    const askInner = inProcessTool({
      name: 'askInner',
      description: 'Ask the inner agent.',
      input: t.object({ q: t.string }),
      execute: async ({ input }) => {
        const answer = await inner(input, { ctx: ctx() });
        results.push(answer);
        return answer;
      },
    });
    const outer = agent({
      ...IO,
      prompt: prompt('nested-outer'),
      vars: ({ input }) => ({ q: input.q }),
      tools: [askInner],
      policy: allow(),
    }).named('nestedOuter');

    model(['answer']);
    const first = await outer.run({ q: 'go' }, { ctx: ctx() });
    model(['ask', 'answer']);
    const second = await outer.continue(
      { q: 'go' },
      { transcript: first.transcript, user: 'ask the inner one' },
      { ctx: ctx() },
    );

    expect(results).toEqual([{ a: 'inner' }]);
    expect(second.output).toEqual({ a: 'outer' });
  });
});
