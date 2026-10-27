// The harness the two `agent-continue*.test.ts` suites share: a scripted model, one declared agent
// with one counting tool. Not shipped (`!src/**/*-fixture.ts`).

import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

// The fixture models are registered by each suite (`useFixtureModels()` in the test file), never
// here: a hook registered while this module loads attaches to the first suite that imports it,
// and the second suite in the same process ran with whatever the one before it had reset.

export const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
export type Step = {
  readonly call: string;
  readonly input?: Record<string, unknown>;
  readonly stop?: 'max_tokens';
};

/** Call N answers `steps[N-1]`, the last one repeating. */
export function model(...steps: readonly Step[]): { seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: [FIXTURE_MODEL],
    generate(request) {
      const step = steps[Math.min(seen.length, steps.length - 1)] ?? { call: 'respond' };
      seen.push(request);
      const result: GenerateResult = {
        model: FIXTURE_MODEL,
        text: '',
        toolCalls: [{ id: `call-${seen.length}`, name: step.call, input: step.input ?? {} }],
        stopReason: step.stop ?? 'tool_use',
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

export const Input = t.object({ topic: t.string });
export const Output = t.object({ title: t.string });
export const ANSWER = { call: 'respond', input: { title: 'Tides' } };
export const BETTER = { call: 'respond', input: { title: 'Tides, revised' } };
export const READ = { call: 'readDoc', input: { id: 'kb-1' } };

export let ran = 0;
export const readDoc: ProjectableAction = {
  name: 'readDoc',
  description: 'Read one document',
  mcp: { expose: true },
  run: () => Promise.resolve(`page ${++ran}`),
};

export let seq = 0;
export function declare(
  extra: { maxTurns?: number; tokensPerRun?: number; onTurn?: (e: AgentTurn) => void } = {},
) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ topic: string }>({
      id: `continued-${seq}`,
      version: '1.0.0',
      system: 'RULES: answer from the knowledge base only.',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    system: () => ({ stable: 'INDEX\nkb-1: tides', run: 'Today is 2026-10-11.' }),
    tools: [readDoc],
    policy: allow(),
    ...(extra.maxTurns === undefined ? {} : { maxTurns: extra.maxTurns }),
    ...(extra.tokensPerRun === undefined ? {} : { budget: { tokensPerRun: extra.tokensPerRun } }),
    ...(extra.onTurn === undefined ? {} : { onTurn: extra.onTurn }),
  }).named(`continued${seq}`);
}

export const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });
export const INPUT = { topic: 'tides' };

/** Before each test: the tool has run for nobody yet. */
export const resetRan = (): void => {
  ran = 0;
};
