/**
 * The loop's mechanics, and the three failures they exist to stop: a run that keeps buying turns
 * after the caller hung up, a turn that pays 5x wall clock for five tools it asked for at once,
 * and a 90-second run that emits nothing until it returns.
 */

import { describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import { createGateway } from './gateway';
import { definePrompt, type Prompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf, EchoProvider } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const Input = t.object({ orderId: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 12,
  outputTokens: 8,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Turn = { readonly calls: readonly { name: string; input: Record<string, unknown> }[] };

/** `onCall` runs BEFORE the turn is answered, so a case can abort from inside a model call. */
function scripted(
  turns: readonly Turn[],
  onCall?: (index: number) => void,
): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: ['claude-opus-5'],
    generate(request) {
      const turn = turns[Math.min(seen.length, turns.length - 1)];
      seen.push(request);
      onCall?.(seen.length);
      return Promise.resolve({
        model: 'claude-opus-5',
        text: '',
        toolCalls: (turn?.calls ?? []).map((call, index) => ({
          id: `call-${seen.length}-${index}`,
          name: call.name,
          input: call.input,
        })),
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf('claude-opus-5', USAGE),
      } satisfies GenerateResult);
    },
    stream: (request) => new EchoProvider().stream(request),
  };
  return { provider, seen };
}

let seq = 0;
function promptFor(): Prompt<{ orderId: string }> {
  seq += 1;
  return definePrompt<{ orderId: string }>({
    id: `loop-${seq}`,
    version: '1.0.0',
    template: 'Resolve order {{orderId}}.',
  });
}

function tool(name: string, run: ProjectableAction['run']): ProjectableAction {
  return { name, description: name, mcp: { expose: true }, run };
}

/** The `tool_result` blocks of the last message, as `[toolUseId, content]` pairs, in order. */
function pairs(request: GenerateRequest | undefined): readonly (readonly [string, string])[] {
  const content = request?.messages.at(-1)?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block.type === 'tool_result' ? [[block.tool_use_id, block.content] as const] : [],
  );
}

describe('cancellation reaches the loop', () => {
  test('a ctx aborted mid-run buys no further turn and starts no further tool', async () => {
    resetAiRuntime();
    const controller = new AbortController();
    const effects: string[] = [];
    const { provider, seen } = scripted([{ calls: [{ name: 'sideEffect', input: {} }] }]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      // The caller goes away while the first tool is running — the realistic shape of an HTTP
      // client that closed the socket at turn 1.
      tools: [
        tool('sideEffect', () => {
          effects.push('ran');
          controller.abort();
          return Promise.resolve('ok');
        }),
      ],
      maxTurns: 8,
      policy: allow(),
    }).named('abortedAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }), signal: controller.signal });
    await expect(support({ orderId: 'o-1' }, { ctx })).rejects.toMatchObject({
      code: 'X_ABORTED',
    });
    // One provider call, not eight. One tool run, not eight.
    expect(seen.length).toBe(1);
    expect(effects).toEqual(['ran']);
  });

  test('a ctx already aborted never reaches the provider at all', async () => {
    resetAiRuntime();
    const controller = new AbortController();
    controller.abort();
    const effects: string[] = [];
    const { provider, seen } = scripted([{ calls: [{ name: 'sideEffect', input: {} }] }]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [
        tool('sideEffect', () => {
          effects.push('ran');
          return Promise.resolve('ok');
        }),
      ],
      policy: allow(),
    }).named('deadAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }), signal: controller.signal });
    await expect(support({ orderId: 'o-1' }, { ctx })).rejects.toMatchObject({
      code: 'X_ABORTED',
    });
    expect(seen.length).toBe(0);
    expect(effects).toEqual([]);
  });

  test("the ctx's signal is forwarded to the provider, so an in-flight call unwinds too", async () => {
    resetAiRuntime();
    const controller = new AbortController();
    const { provider, seen } = scripted([{ calls: [{ name: 'respond', input: { answer: 'x' } }] }]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
    }).named('signalAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }), signal: controller.signal });
    await support({ orderId: 'o-1' }, { ctx });
    expect(seen[0]?.signal).toBe(controller.signal);
  });
});

describe('the tools of one turn run concurrently', () => {
  // No assertion on DURATION. `slow` cannot settle until `fast` has released it, so a serial loop
  // records `['slow', 'fast']` and this fails; run concurrently it records `['fast', 'slow']`. The
  // 50ms escape is there only so a broken loop FAILS instead of hanging the suite.
  test('results pair with their own tool_use ids under out-of-order completion', async () => {
    resetAiRuntime();
    const finished: string[] = [];
    let release = (): void => {};
    const gate = Promise.race([
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      Bun.sleep(50),
    ]);
    const { provider, seen } = scripted([
      {
        calls: [
          { name: 'slow', input: {} },
          { name: 'fast', input: {} },
        ],
      },
    ]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [
        tool('slow', async () => {
          await gate;
          finished.push('slow');
          return 'SLOW';
        }),
        tool('fast', () => {
          finished.push('fast');
          release();
          return Promise.resolve('FAST');
        }),
      ],
      maxTurns: 2,
      policy: allow(),
    }).named('concurrentAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }) });
    await expect(support({ orderId: 'o-1' }, { ctx })).rejects.toMatchObject({
      code: 'X_AGENT_MAX_TURNS',
    });
    // `fast` settled first, on the turn that matters (turn 2 replays the same batch through an
    // already-open gate, so only the first two entries carry the ordering fact).
    expect(finished.slice(0, 2)).toEqual(['fast', 'slow']);
    // ...and the transcript still pairs each result with the call that asked for it, in the order
    // the model emitted them. A `Promise.race`-shaped fix would have swapped these.
    expect(pairs(seen[1])).toEqual([
      ['call-1-0', '"SLOW"'],
      ['call-1-1', '"FAST"'],
    ]);
  }, 2_000);
});

describe('a run reports its turns while it is still running', () => {
  test('onTurn fires once per completed turn, with that turn alone', async () => {
    resetAiRuntime();
    const events: AgentTurn[] = [];
    const { provider } = scripted([
      { calls: [{ name: 'ping', input: {} }] },
      { calls: [{ name: 'respond', input: { answer: 'done' } }] },
    ]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [tool('ping', () => Promise.resolve('pong'))],
      policy: allow(),
      onTurn: (event) => {
        events.push(event);
      },
    }).named('observedAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }) });
    expect(await support({ orderId: 'o-1' }, { ctx })).toEqual({ answer: 'done' });
    expect(events.map((event) => event.turn)).toEqual([1, 2]);
    // `respond` is the answer, not a tool call — an observer counting work must not see it.
    expect(events.map((event) => event.toolCalls)).toEqual([['ping'], []]);
    // Per turn, never the running total: a caller summing them must get the run's real cost.
    expect(events.every((event) => event.cost.minor === events[0]?.cost.minor)).toBe(true);
    expect(events[0]?.maxTurns).toBe(8);
  });

  test('a throw from onTurn fails the run rather than being swallowed', async () => {
    resetAiRuntime();
    const { provider, seen } = scripted([
      { calls: [{ name: 'respond', input: { answer: 'done' } }] },
    ]);
    configureAi({ gateway: createGateway({ providers: [provider] }) });

    const support = agent({
      input: Input,
      output: Output,
      prompt: promptFor(),
      vars: ({ input }) => ({ orderId: input.orderId }),
      tools: [],
      policy: allow(),
      onTurn: () => {
        throw new Error('sink is down');
      },
    }).named('noisyAgent');

    const ctx = createContext({ actor: userActor({ id: 'user-7' }) });
    await expect(support({ orderId: 'o-1' }, { ctx })).rejects.toThrow('sink is down');
    expect(seen.length).toBe(1);
  });
});
