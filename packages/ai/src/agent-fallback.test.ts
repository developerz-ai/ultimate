// `agent()`'s half of `fallbackModels` and `providerOptions`: the declaration carries both onto every
// turn, a bad bag fails the declaration, a run's own model is never asked twice, and the run's bill
// and trace count the failed model.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import { ctxOf, resetTelemetry, subscribe, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import type { AgentTurn } from './agent-def';
import { addMoney, exactCostOf } from './cost';
import { AiTransportError } from './errors';
import { providerGateway } from './gateway';
import { inProcessTool } from './in-process-tool';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { Provider } from './provider';
import { meteredRun } from './run-meter';
import { installAiGateway, resetAiRuntime } from './runtime';
import { scriptedProvider } from './scripted-provider';

useFixtureModels();

const SECOND = 'claude-sonnet-5';
const Input = t.object({ topic: t.string });
const Output = t.object({ answer: t.string });
const ctx = ctxOf({ actor: userActor({ id: 'ada', orgId: 'org-a' }) });

let spans: ReadableSpan[] = [];
beforeEach(() => {
  resetAiRuntime();
  resetTelemetry();
  spans = [];
  subscribe('span.end', (event) => spans.push(event.payload));
});

const overloaded: Provider = {
  name: 'primary-host',
  models: [FIXTURE_MODEL],
  generate: async () => {
    throw new AiTransportError({ provider: 'primary-host', status: 529, detail: 'overloaded' });
  },
  stream: () => {
    throw new AiTransportError({ provider: 'primary-host', status: 529, detail: 'overloaded' });
  },
};

/** A scripted host serving only `SECOND`, answering through `respond`. */
function second() {
  const scripted = scriptedProvider({ turns: [{ answer: { answer: 'ok' } }], name: 'second' });
  const provider: Provider = {
    name: 'second-host',
    models: [SECOND],
    generate: (request) => scripted.generate(request),
    stream: (request) => scripted.stream(request),
  };
  return { provider, seen: scripted.seen };
}

let seq = 0;
function declared(extra: Record<string, unknown>) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ topic: string }>({
      id: `fallback-agent-${seq}`,
      version: '1.0.0',
      template: 'Write about {{topic}}.',
    }),
    vars: ({ input }) => ({ topic: input.topic }),
    tools: [],
    policy: allow(),
    model: FIXTURE_MODEL,
    ...extra,
  }).named(`fallbackAgent${seq}`);
}

describe('agent() fallbackModels', () => {
  test('a turn answers on the second model, billed for both attempts, one attempt span each', async () => {
    const host = second();
    installAiGateway(
      providerGateway({
        providers: [overloaded, host.provider],
        retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
        breaker: 'off',
      }),
    );
    const turns: AgentTurn[] = [];
    const run = declared({
      fallbackModels: [SECOND],
      onTurn: (turn: AgentTurn) => turns.push(turn),
    });

    const { value, billed } = await meteredRun(() => run({ topic: 'x' }, { ctx }));
    expect(value).toEqual({ answer: 'ok' });
    expect(turns.map((turn) => turn.model)).toEqual([SECOND]);
    expect(billed).toMatchObject({ calls: 1, unsettled: 1 });
    expect(
      spans
        .filter((span) => span.name === 'ai.model.attempt')
        .map((span) => span.attributes['gen_ai.request.model']),
    ).toEqual([FIXTURE_MODEL, SECOND]);
  });

  test('a run whose own model is in the chain is not refused: it is left out of the chain', async () => {
    const host = second();
    installAiGateway(providerGateway({ providers: [host.provider], breaker: 'off' }));
    const run = declared({ model: SECOND, fallbackModels: [SECOND, FIXTURE_MODEL] });
    await run({ topic: 'x' }, { ctx });
    expect(host.seen[0]?.fallbackModels).toEqual([FIXTURE_MODEL]);
  });
});

describe('a run whose turns answered on two models', () => {
  test("each turn is priced at its own model's rate, the fallback's never re-priced", async () => {
    // Turn 1: the primary asks for a tool. Turn 2: the primary is overloaded and the fallback
    // answers. One turn on each model; the last one fell over.
    const usage = {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const primary = scriptedProvider({ turns: [{ calls: [{ call: 'note' }] }], usage });
    const fallback = scriptedProvider({ turns: [{ answer: { answer: 'ok' } }], usage });
    let primaryCalls = 0;
    const flaky: Provider = {
      name: 'primary-host',
      models: [FIXTURE_MODEL],
      generate: (request) => {
        primaryCalls += 1;
        return primaryCalls === 2 ? overloaded.generate(request) : primary.generate(request);
      },
      stream: (request) => primary.stream(request),
    };
    installAiGateway(
      providerGateway({
        providers: [
          flaky,
          {
            name: 'second-host',
            models: [SECOND],
            generate: (r) => fallback.generate(r),
            stream: (r) => fallback.stream(r),
          },
        ],
        retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
        breaker: 'off',
      }),
    );
    const note = inProcessTool({
      name: 'note',
      description: 'Take a note.',
      input: t.object({}),
      execute: () => 'noted',
    });
    const turns: AgentTurn[] = [];
    await declared({
      tools: [note],
      fallbackModels: [SECOND],
      onTurn: (turn: AgentTurn) => turns.push(turn),
    })({ topic: 'x' }, { ctx });

    expect(turns.map((turn) => turn.model)).toEqual([FIXTURE_MODEL, SECOND]);
    expect(turns[1]?.run.costExact).toEqual(
      addMoney(exactCostOf(SECOND, usage), exactCostOf(FIXTURE_MODEL, usage)),
    );
  });
});

describe('agent() providerOptions', () => {
  test('the bag reaches every turn as declared', async () => {
    const host = second();
    installAiGateway(providerGateway({ providers: [host.provider], breaker: 'off' }));
    await declared({
      model: SECOND,
      providerOptions: { anthropic: { metadata: { user_id: 'u-1' } } },
    })({ topic: 'x' }, { ctx });
    expect(host.seen[0]?.providerOptions).toEqual({ anthropic: { metadata: { user_id: 'u-1' } } });
  });

  test('a bad bag fails the declaration, before any gateway or request exists', () => {
    expect(() => declared({ providerOptions: { anthropic: { top_p: 1 } } })).toThrow(
      /X_AI_REQUEST_INVALID/,
    );
  });
});
