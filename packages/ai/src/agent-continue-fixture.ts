// The harness the two `agent-continue*.test.ts` suites share: a `scriptedProvider`, one declared agent
// with one counting tool. Not shipped (`!src/**/*-fixture.ts`).

import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, TokenUsage } from './provider';
import { installAiGateway, resetAiRuntime } from './runtime';
import type { ScriptedTurn } from './scripted-provider';
import { scriptedProvider } from './scripted-provider';
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
export type Step = ScriptedTurn;

/** Call N answers `steps[N-1]`; one call past the last is `X_AI_SCRIPT_EXHAUSTED`. */
export function model(...steps: readonly Step[]): { seen: readonly GenerateRequest[] } {
  const provider = scriptedProvider({ turns: steps, usage: USAGE });
  resetAiRuntime();
  installAiGateway(providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }));
  return { seen: provider.seen };
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
