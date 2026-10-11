/**
 * The two guards an unattended run needs: a loop that repeats itself is stopped before it spends
 * every turn, and a run that outlives its deadline is stopped whatever it is waiting on.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

useFixtureModels();

const Input = t.object({ id: t.string });
const Output = t.object({ answer: t.string });
const USAGE: TokenUsage = {
  inputTokens: 5,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

type Call = { readonly name: string; readonly input: Record<string, unknown> };

/** Answers turn N with `script(N)`; `wait` holds every answer until the request's signal aborts. */
function model(script: (turn: number) => Call, wait = false) {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: [FIXTURE_MODEL],
    generate(request) {
      seen.push(request);
      const call = script(seen.length);
      const result: GenerateResult = {
        model: FIXTURE_MODEL,
        text: '',
        toolCalls: [{ id: `call-${seen.length}`, ...call }],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage: USAGE,
        cost: costOf(FIXTURE_MODEL, USAGE),
      };
      if (!wait) return Promise.resolve(result);
      // A socket that only ever ends by being aborted — what a hung provider looks like.
      return new Promise((_, reject) => {
        request.signal?.addEventListener('abort', () => reject(request.signal?.reason));
      });
    },
    stream: (request) => echoProvider().stream(request),
  };
  resetAiRuntime();
  configureAi({ gateway: providerGateway({ defaultModel: FIXTURE_MODEL, providers: [provider] }) });
  return seen;
}

let seq = 0;
function declare(
  tools: readonly ProjectableAction[],
  extra: { maxRepeatedToolCalls?: number; deadlineMs?: number; maxTurns?: number } = {},
) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ id: string }>({
      id: `guard-${seq}`,
      version: '1.0.0',
      template: 'Resolve {{id}}.',
    }),
    vars: ({ input }) => ({ id: input.id }),
    tools,
    maxTurns: 8,
    policy: allow(),
    ...extra,
  }).named(`guardAgent${seq}`);
}

const tool = (name: string, run: ProjectableAction['run']): ProjectableAction => ({
  name,
  description: name,
  mcp: { expose: true },
  run,
});

const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });
const status = (): Call => ({ name: 'status', input: { id: 'j-1' } });

describe('a loop that repeats itself is stopped', () => {
  test('the same call with the same result, three turns running, is X_AGENT_TOOL_LOOP', async () => {
    const seen = model(status);
    let ran = 0;
    const run = declare([
      tool('status', () => {
        ran += 1;
        return Promise.resolve('pending');
      }),
    ]);
    const call = run({ id: 'x' }, { ctx: ctx() });
    await expect(call).rejects.toMatchObject({
      code: 'X_AGENT_TOOL_LOOP',
      meta: { repeats: 3, tools: ['status'] },
    });
    // Three turns bought, not eight: the fourth request was never sent.
    expect(seen).toHaveLength(3);
    expect(ran).toBe(3);
  });

  test('a polled tool whose answer keeps changing is progress, and is left alone', async () => {
    let ran = 0;
    const seen = model((turn) =>
      turn <= 5 ? status() : { name: 'respond', input: { answer: 'done' } },
    );
    const run = declare([
      tool('status', () => {
        ran += 1;
        return Promise.resolve(`pending ${ran}`);
      }),
    ]);
    expect(await run({ id: 'x' }, { ctx: ctx() })).toEqual({ answer: 'done' });
    expect(seen).toHaveLength(6);
  });

  test('a different call in between resets the count; key order in the arguments does not', async () => {
    // a, a, b, a, a — never three in a row — then answer.
    const order = ['a', 'a', 'b', 'a', 'a'];
    const mixed = model((turn) => {
      const id = order[turn - 1];
      if (id === undefined) return { name: 'respond', input: { answer: 'done' } };
      // The same arguments spelled in two key orders are the same call.
      return { name: 'status', input: turn % 2 === 0 ? { id, n: 1 } : { n: 1, id } };
    });
    const run = declare([tool('status', () => Promise.resolve('pending'))]);
    expect(await run({ id: 'x' }, { ctx: ctx() })).toEqual({ answer: 'done' });
    expect(mixed).toHaveLength(6);

    const same = model((turn) => ({
      name: 'status',
      input: turn % 2 === 0 ? { id: 'a', n: 1 } : { n: 1, id: 'a' },
    }));
    const again = declare([tool('status', () => Promise.resolve('pending'))]);
    await expect(again({ id: 'x' }, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_TOOL_LOOP',
    });
    expect(same).toHaveLength(3);
  });

  test('the limit is the declaration’s, and a limit that could never pass a first turn is refused', async () => {
    const seen = model(status);
    const run = declare([tool('status', () => Promise.resolve('pending'))], {
      maxRepeatedToolCalls: 5,
    });
    await expect(run({ id: 'x' }, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_TOOL_LOOP',
      meta: { repeats: 5 },
    });
    expect(seen).toHaveLength(5);
    for (const bad of [1, 0, Number.NaN, 2.5]) {
      expect(() => declare([], { maxRepeatedToolCalls: bad })).toThrow('maxRepeatedToolCalls');
    }
  });
});

describe('a run has a deadline when it declares one', () => {
  test('a hung model call is aborted at the deadline and reported as X_AGENT_DEADLINE', async () => {
    const seen = model(status, true);
    const run = declare([tool('status', () => Promise.resolve('pending'))], { deadlineMs: 30 });
    const started = performance.now();
    await expect(run({ id: 'x' }, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_DEADLINE',
      meta: { deadlineMs: 30 },
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    // The socket itself heard it: the request's own signal is aborted.
    expect(seen[0]?.signal?.aborted).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test('a tool that never returns does not hold the run past it, and no further turn is bought', async () => {
    const seen = model(status);
    const run = declare([tool('status', () => new Promise<string>(() => {}))], { deadlineMs: 30 });
    await expect(run({ id: 'x' }, { ctx: ctx() })).rejects.toMatchObject({
      code: 'X_AGENT_DEADLINE',
    });
    expect(seen).toHaveLength(1);
  });

  test('the caller leaving first is still X_ABORTED, and no deadline means no timer', async () => {
    const controller = new AbortController();
    const hung = model(status, true);
    const run = declare([tool('status', () => Promise.resolve('pending'))], { deadlineMs: 5_000 });
    const call = run(
      { id: 'x' },
      { ctx: ctxOf({ actor: userActor({ id: 'u-1' }), signal: controller.signal }) },
    );
    setTimeout(() => controller.abort(), 10);
    // Not the deadline's code, and not the transport's either: the aborted socket surfaces as a
    // provider failure, which is retryable — a job would have re-run a run nobody is waiting for.
    await expect(call).rejects.toMatchObject({ code: 'X_ABORTED' });
    expect(hung).toHaveLength(1);

    // Undeclared: the request is handed the caller's own signal, untouched.
    const seen = model(() => ({ name: 'respond', input: { answer: 'done' } }));
    const c = ctx();
    await declare([])({ id: 'x' }, { ctx: c });
    expect(seen[0]?.signal).toBe(c.signal);
  });

  test('a deadline that is not a positive whole number of milliseconds is refused at declaration', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => declare([], { deadlineMs: bad })).toThrow('deadlineMs');
    }
  });
});
