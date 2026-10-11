/**
 * Continuing an agent run. The failure first: `agent()` could only ever START — one user message,
 * a fresh transcript — so asking for a correction to a finished answer was a whole new run that
 * re-ran every tool and re-paid every turn. `.run()` keeps the transcript; `.continue()` appends
 * one user turn to it and resumes the loop under the SAME ceilings.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import type { AgentTranscript } from './agent-continue';
import { MAX_TRANSCRIPT_CHARS } from './agent-continue';
import { billedOf } from './billed';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { FIXTURE_MODEL, useFixtureModels } from './model-fixture';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { anthropicProvider, costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

useFixtureModels();

const USAGE: TokenUsage = {
  inputTokens: 1_000,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
type Step = { readonly call: string; readonly input?: Record<string, unknown> };

/** Call N answers `steps[N-1]`, the last one repeating. */
function model(...steps: readonly Step[]): { seen: GenerateRequest[] } {
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

const Input = t.object({ topic: t.string });
const Output = t.object({ title: t.string });
const ANSWER = { call: 'respond', input: { title: 'Tides' } };
const BETTER = { call: 'respond', input: { title: 'Tides, revised' } };
const READ = { call: 'readDoc', input: { id: 'kb-1' } };

let ran = 0;
const readDoc: ProjectableAction = {
  name: 'readDoc',
  description: 'Read one document',
  mcp: { expose: true },
  run: () => Promise.resolve(`page ${++ran}`),
};

let seq = 0;
function declare(
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

const ctx = () => ctxOf({ actor: userActor({ id: 'u-1' }) });
const INPUT = { topic: 'tides' };

beforeEach(() => {
  ran = 0;
});

describe('.run() keeps the transcript', () => {
  test('the answer, the handle, the turns and the usage — and a plain call is unchanged', async () => {
    model(READ, ANSWER);
    const write = declare();

    expect(await write(INPUT, { ctx: ctx() })).toEqual({ title: 'Tides' });
    model(READ, ANSWER);
    const run = await write.run(INPUT, { ctx: ctx() });

    expect(run.output).toEqual({ title: 'Tides' });
    expect(run.turns).toBe(2);
    expect(run.usage.usage).toMatchObject({ inputTokens: 2_000, outputTokens: 400 });
    expect(run.transcript.turns).toBe(2);
    // user, assistant(readDoc), user(result), assistant(respond)
    expect(run.transcript.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    // Plain data: it survives the round trip an app's storage puts it through.
    expect(JSON.parse(JSON.stringify(run.transcript))).toEqual(run.transcript);
  });
});

describe('.continue() resumes the loop', () => {
  test('the request is the old transcript, byte for byte, plus ONE user turn — and no tool re-runs', async () => {
    const { seen } = model(READ, ANSWER, BETTER);
    const write = declare();
    const first = await write.run(INPUT, { ctx: ctx() });
    const stored = JSON.parse(JSON.stringify(first.transcript)) as AgentTranscript;

    const second = await write.continue(
      INPUT,
      { transcript: stored, user: 'Add "revised".' },
      { ctx: ctx() },
    );

    expect(second.output).toEqual({ title: 'Tides, revised' });
    expect(ran).toBe(1);
    const [, last, continued] = seen;
    const previous = [...(last?.messages ?? []), first.transcript.messages.at(-1)];
    const sent = continued?.messages ?? [];
    // The prefix a provider's prompt cache keys on: the system and every earlier message.
    expect(JSON.stringify(continued?.system)).toBe(JSON.stringify(last?.system));
    expect(JSON.stringify(sent.slice(0, previous.length))).toBe(JSON.stringify(previous));
    expect(sent).toHaveLength(previous.length + 1);
    // The appended turn answers the accepted `respond` call, then says what to change.
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'call-2', content: 'Accepted as the answer so far.' },
        { type: 'text', text: 'Add "revised".' },
      ],
    });
    expect(continued?.promptCache).toEqual(last?.promptCache);
  });

  test('on the Anthropic wire the stable system block is the same bytes and the mark follows the new tail', async () => {
    model(READ, ANSWER, BETTER);
    const write = declare();
    const first = await write.run(INPUT, { ctx: ctx() });
    const { seen } = model(BETTER);
    await write.continue(INPUT, { transcript: first.transcript, user: 'Revise.' }, { ctx: ctx() });

    const wire = anthropicProvider({ apiKey: 'k', models: [FIXTURE_MODEL] });
    const request = seen[0] ?? expect.unreachable('no continued request');
    const body = wire.body(request) as {
      system: { text: string }[];
      messages: { content: unknown }[];
    };
    expect(body.system[0]?.text).toBe(
      'RULES: answer from the knowledge base only.\n\nINDEX\nkb-1: tides',
    );
    // The breakpoints the wire's rule spends: the new tail, and the message before it — which is
    // the previous run's LAST message, the exact boundary that run's final request wrote to the
    // cache. Reading resumes there; nothing earlier is marked or moved.
    const marked = body.messages.map((message) =>
      JSON.stringify(message).includes('cache_control'),
    );
    expect(marked).toEqual([false, false, false, true, true]);
    expect(JSON.stringify(body.messages.slice(0, 3))).toBe(
      JSON.stringify(first.transcript.messages.slice(0, 3)),
    );
  });

  test('usage adds to the same run total, and onTurn reports the cumulative run', async () => {
    const turns: AgentTurn[] = [];
    model(READ, ANSWER, BETTER);
    const write = declare({ onTurn: (event) => void turns.push(event) });
    const first = await write.run(INPUT, { ctx: ctx() });
    const second = await write.continue(
      INPUT,
      { transcript: first.transcript, user: 'Revise.' },
      { ctx: ctx() },
    );

    expect(second.turns).toBe(3);
    expect(second.transcript.turns).toBe(3);
    expect(second.usage.usage).toMatchObject({ inputTokens: 3_000, outputTokens: 600 });
    expect(second.usage.cost).toEqual(
      costOf(FIXTURE_MODEL, { ...USAGE, inputTokens: 3_000, outputTokens: 600 }),
    );
    expect(turns.map((event) => event.turn)).toEqual([1, 2, 3]);
    expect(turns.at(-1)?.run.usage.inputTokens).toBe(3_000);
  });

  test('a continuation can be continued', async () => {
    model(READ, ANSWER, BETTER, ANSWER);
    const write = declare();
    const first = await write.run(INPUT, { ctx: ctx() });
    const second = await write.continue(
      INPUT,
      { transcript: first.transcript, user: 'Revise.' },
      { ctx: ctx() },
    );
    const third = await write.continue(
      INPUT,
      { transcript: second.transcript, user: 'Undo.' },
      { ctx: ctx() },
    );
    expect(third.turns).toBe(4);
    expect(third.output).toEqual({ title: 'Tides' });
  });
});

describe('the ceilings count the run and its continuations together', () => {
  test('maxTurns: a run that used two of three has ONE turn left', async () => {
    const { seen } = model(READ, ANSWER, READ);
    const write = declare({ maxTurns: 3 });
    const first = await write.run(INPUT, { ctx: ctx() });

    const outcome = await write
      .continue(INPUT, { transcript: first.transcript, user: 'Revise.' }, { ctx: ctx() })
      .catch((error: unknown) => error);
    expect(outcome).toMatchObject({ code: 'X_AGENT_MAX_TURNS' });
    expect(seen).toHaveLength(3);
    // The bill of THIS call: one turn.
    expect(billedOf(outcome)).toMatchObject({ calls: 1 });
  });

  test('maxTurns: a run that used them all is refused before a provider call', async () => {
    const { seen } = model(READ, ANSWER);
    const write = declare({ maxTurns: 2 });
    const first = await write.run(INPUT, { ctx: ctx() });
    await expect(
      write.continue(INPUT, { transcript: first.transcript, user: 'Revise.' }, { ctx: ctx() }),
    ).rejects.toMatchObject({ code: 'X_AGENT_MAX_TURNS' });
    expect(seen).toHaveLength(2);
  });

  test('budget.tokensPerRun: what the run already used is gone', async () => {
    const { seen } = model(READ, ANSWER, BETTER);
    // Each call reserves about 4,100 tokens (the prompt plus the 4,096 completion ceiling) and
    // settles at 1,200. 6,000 fits the two turns of the run — and would fit a third on a FRESH
    // ledger. With the 2,400 the run already used counted, 3,600 are left, and the third does not.
    const write = declare({ tokensPerRun: 6_000 });
    const first = await write.run(INPUT, { ctx: ctx() });
    await expect(
      write.continue(INPUT, { transcript: first.transcript, user: 'Revise.' }, { ctx: ctx() }),
    ).rejects.toMatchObject({ code: 'X_AI_BUDGET_EXCEEDED' });
    expect(seen).toHaveLength(2);
  });
});

describe('the handle is screened before anything is spent', () => {
  const refused = async (
    mutate: (handle: Record<string, unknown>) => unknown,
    user = 'Revise.',
  ) => {
    const { seen } = model(READ, ANSWER, BETTER);
    const write = declare();
    const first = await write.run(INPUT, { ctx: ctx() });
    const handle = mutate(JSON.parse(JSON.stringify(first.transcript)) as Record<string, unknown>);
    const outcome = await write
      .continue(INPUT, { transcript: handle as AgentTranscript, user }, { ctx: ctx() })
      .catch((error: unknown) => error);
    expect(seen).toHaveLength(2);
    return outcome as { code: string; cause: string };
  };
  const messagesOf = (handle: Record<string, unknown>) =>
    handle['messages'] as { role: string; content: unknown }[];

  test.each([
    ['not an object', () => 'a string', 'not an object'],
    ['another version', (h: Record<string, unknown>) => ({ ...h, v: 2 }), 'version 2'],
    [
      'another agent',
      (h: Record<string, unknown>) => ({ ...h, agent: 'other@1.0.0' }),
      'other@1.0.0',
    ],
    [
      'a turn count that is not one',
      (h: Record<string, unknown>) => ({ ...h, turns: -1 }),
      'turn count',
    ],
    [
      'usage that is not counts',
      (h: Record<string, unknown>) => ({ ...h, usage: { inputTokens: 'x' } }),
      'usage',
    ],
    [
      'a message out of order',
      (h: Record<string, unknown>) => ({ ...h, messages: messagesOf(h).slice(1) }),
      'messages[0] is not a user message',
    ],
    [
      'a tool call nothing answers',
      (h: Record<string, unknown>) => {
        const messages = messagesOf(h);
        return {
          ...h,
          messages: [messages[0], messages[1], { role: 'user', content: 'hm' }, messages[3]],
        };
      },
      'does not answer tool call "call-1"',
    ],
    [
      'a block that is not one a loop writes',
      (h: Record<string, unknown>) => {
        const messages = messagesOf(h);
        return {
          ...h,
          messages: [{ role: 'user', content: [{ type: 'image' }] }, ...messages.slice(1)],
        };
      },
      'messages[0] has no content',
    ],
    [
      'more than a handle may weigh',
      (h: Record<string, unknown>) => {
        const messages = messagesOf(h);
        return {
          ...h,
          messages: [
            { role: 'user', content: 'x'.repeat(MAX_TRANSCRIPT_CHARS) },
            ...messages.slice(1),
          ],
        };
      },
      'characters, over',
    ],
  ])('%s is X_AGENT_TRANSCRIPT_INVALID', async (_label, mutate, says) => {
    const outcome = await refused(mutate as (h: Record<string, unknown>) => unknown);
    expect(outcome.code).toBe('X_AGENT_TRANSCRIPT_INVALID');
    expect(outcome.cause).toContain(says);
  });

  test('an empty user turn is refused: a continuation has to say something', async () => {
    const outcome = await refused((handle) => handle, '   ');
    expect(outcome.code).toBe('X_AGENT_TRANSCRIPT_INVALID');
    expect(outcome.cause).toContain('user turn is empty');
  });
});
