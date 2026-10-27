// The harness the two per-run suites share (`agent-per-run.test.ts`, `agent-run-limits.test.ts`):
// a scripted model that serves two registered ids and records every request, two counting tools,
// and one agent declared with whatever per-run picks a test hands it. Not shipped
// (`!src/**/*-fixture.ts`).

import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentDef } from './agent';
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

/** The second id the provider serves — a per-run pick that is not the gateway's default. */
export const OTHER_MODEL = 'claude-sonnet-5';

/** One turn's usage: on `FIXTURE_MODEL` it costs exactly one US cent (0.5 in + 0.5 out). */
export const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export type Step = { readonly call: string; readonly input?: Record<string, unknown> };
export const ANSWER: Step = { call: 'respond', input: { title: 'Tides' } };
export const READ: Step = { call: 'readDoc', input: { id: 'kb-1' } };
export const PUBLISH: Step = { call: 'publish', input: {} };

/** Call N answers `steps[N-1]`, the last one repeating; every request is kept, in order. */
export function scripted(...steps: readonly Step[]): { seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: [FIXTURE_MODEL, OTHER_MODEL],
    generate(request) {
      const step = steps[Math.min(seen.length, steps.length - 1)] ?? ANSWER;
      seen.push(request);
      const result: GenerateResult = {
        model: request.model ?? FIXTURE_MODEL,
        text: '',
        toolCalls: [{ id: `call-${seen.length}`, name: step.call, input: step.input ?? {} }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf(request.model ?? FIXTURE_MODEL, USAGE),
      };
      return Promise.resolve(result);
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  configureAi({ gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }) });
  return { seen };
}

/** How often each tool and `vars()` ran — a refusal "before anything is loaded" leaves all at 0. */
export const runs = { readDoc: 0, publish: 0, vars: 0 };

export function resetRuns(): void {
  runs.readDoc = 0;
  runs.publish = 0;
  runs.vars = 0;
}

const tool = (name: 'readDoc' | 'publish'): ProjectableAction => ({
  name,
  description: `${name} one document`,
  mcp: { expose: true },
  run: () => {
    runs[name] += 1;
    return Promise.resolve(`${name} ok`);
  },
});

export const readDoc = tool('readDoc');
export const publish = tool('publish');

export const Input = t.object({ topic: t.string, tier: t.string });
export const Output = t.object({ title: t.string });
type In = typeof Input;
type Out = typeof Output;
type Vars = { topic: string };

/** The per-run half a test varies; everything else is one fixed declaration. */
export type Picks = Partial<
  Pick<
    AgentDef<In, Out, Vars>,
    | 'model'
    | 'offerTools'
    | 'limits'
    | 'budget'
    | 'maxTurns'
    | 'maxTokens'
    | 'deadlineMs'
    | 'maxRepeatedToolCalls'
  >
>;

let seq = 0;
/** The fixed declaration, under a fresh prompt id — what `declare` hands `agent()`. */
export function definition(picks: Picks = {}): AgentDef<In, Out, Vars> {
  seq += 1;
  return {
    input: Input,
    output: Output,
    prompt: definePrompt<Vars>({
      id: `per-run-${seq}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => {
      runs.vars += 1;
      return { topic: input.topic };
    },
    tools: [readDoc, publish],
    policy: allow(),
    ...picks,
  };
}

export function declare(picks: Picks = {}) {
  const def = definition(picks);
  return agent(def).named(`perRun${seq}`);
}

export const ctx = (id = 'u-1') => ctxOf({ actor: userActor({ id }) });
export const FREE = { topic: 'tides', tier: 'free' };
export const PRO = { topic: 'tides', tier: 'pro' };

/** The tool names one request offered, `respond` included, in the order sent. */
export const offeredIn = (request: GenerateRequest | undefined): readonly string[] =>
  (request?.tools ?? []).map((tool) => tool.name);
