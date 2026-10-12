/**
 * Provider prompt caching through the loop: what `agent()` asks every turn's request to cache, and
 * the two properties a cache hit depends on — a stable block that is the same BYTES across turns
 * and runs, and a mark that follows the transcript's tail.
 */

import { describe, expect, test } from 'bun:test';
import { ctxOf, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AgentTurn } from './agent';
import { agent } from './agent';
import { echoProvider } from './echo-provider';
import { providerGateway } from './gateway';
import { registerModel } from './models';
import { chatCompletionBody } from './openai-body';
import { definePrompt } from './prompt';
import type { GenerateRequest, GenerateResult, Provider, TokenUsage } from './provider';
import { anthropicProvider, costOf } from './provider';
import { configureAi, resetAiRuntime } from './runtime';
import type { ProjectableAction } from './tools';

const MODEL = 'anthropic/claude-sonnet-5.5';
const usd = (minor: number) => ({ minor, currency: 'USD' });

/** OpenRouter's list prices for the id above, 2026-10-11: $2 in, $10 out, $0.10 read, $2.50 write. */
function register(): void {
  registerModel({
    id: MODEL,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    inputPerMillion: usd(200),
    outputPerMillion: usd(1_000),
    cacheReadPerMillion: usd(10),
    cacheWritePerMillion: usd(250),
    cacheMinimumTokens: 512,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
}

const Input = t.object({ question: t.string });
const Output = t.object({ answer: t.string });
const RULES = 'RULES: answer from the index only.';
const INDEX = `INDEX\n${Array.from({ length: 40 }, (_, n) => `doc-${n}: title ${n}`).join('\n')}`;
const MARK = { type: 'ephemeral' };

/** Two tool turns, then an answer — with the usage a caching provider reports for each. */
const USAGES: readonly TokenUsage[] = [
  { inputTokens: 20, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 6_000 },
  { inputTokens: 10, outputTokens: 30, cacheReadTokens: 6_000, cacheWriteTokens: 300 },
  { inputTokens: 10, outputTokens: 40, cacheReadTokens: 6_300, cacheWriteTokens: 300 },
];

function scripted(): { provider: Provider; seen: GenerateRequest[] } {
  const seen: GenerateRequest[] = [];
  const provider: Provider = {
    name: 'scripted',
    models: [MODEL],
    generate(request) {
      const turn = seen.length % USAGES.length;
      seen.push(request);
      const usage = USAGES[turn] ?? expect.unreachable('no usage scripted');
      const call =
        turn < 2
          ? { id: `call-${seen.length}`, name: 'readDoc', input: { n: turn } }
          : { id: `call-${seen.length}`, name: 'respond', input: { answer: 'done' } };
      return Promise.resolve({
        model: MODEL,
        text: '',
        toolCalls: [call],
        stopReason: 'tool_use',
        stopDetails: undefined,
        usage,
        cost: costOf(MODEL, usage),
      } satisfies GenerateResult);
    },
    stream: (request) => echoProvider().stream(request),
  };
  return { provider, seen };
}

const readDoc: ProjectableAction = {
  name: 'readDoc',
  description: 'read one document',
  mcp: { expose: true },
  run: ({ input }) => Promise.resolve(`body of ${JSON.stringify(input)}`),
};

let seq = 0;
function declare(
  extra: Partial<
    Parameters<typeof agent<typeof Input, typeof Output, { question: string }>>[0]
  > = {},
  turns: AgentTurn[] = [],
  dynamic = true,
) {
  seq += 1;
  return agent({
    input: Input,
    output: Output,
    prompt: definePrompt<{ question: string }>({
      id: `kb-${seq}`,
      version: '1.0.0',
      system: RULES,
      template: 'Question: {{question}}',
    }),
    vars: ({ input }) => ({ question: input.question }),
    ...(dynamic
      ? {
          system: ({ input }: { input: { question: string } }) => ({
            stable: INDEX,
            run: `Asked: ${input.question.length} chars`,
          }),
        }
      : {}),
    tools: [readDoc],
    policy: allow(),
    onTurn: (turn) => void turns.push(turn),
    ...extra,
  }).named(`kbAgent${seq}`);
}

function install(): GenerateRequest[] {
  resetAiRuntime();
  register();
  const { provider, seen } = scripted();
  configureAi({ gateway: providerGateway({ defaultModel: MODEL, providers: [provider] }) });
  return seen;
}

const ctx = () => ctxOf({ actor: userActor({ id: 'u-1', orgId: 'org-1' }) });

/** The request as the chat-completions wire to OpenRouter would carry it. */
const wire = (request: GenerateRequest) =>
  chatCompletionBody({
    request,
    model: MODEL,
    provider: 'openrouter',
    stream: false,
    baseUrl: 'https://openrouter.ai/api/v1',
  })['messages'] as { role: string; content: unknown }[];

/** The first content part of a message whose content is parts. */
const firstPart = (message: { content: unknown } | undefined): unknown =>
  Array.isArray(message?.content) ? message.content[0] : undefined;

/** Indexes of the messages whose content carries a mark. */
const markedAt = (messages: readonly unknown[]): number[] =>
  messages.flatMap((message, index) =>
    JSON.stringify(message).includes('cache_control') ? [index] : [],
  );

describe('agent() caches its prefix by default', () => {
  test('every turn carries the hint; the stable block is byte-identical across turns and runs', async () => {
    const seen = install();
    const kb = declare();
    await kb({ question: 'first?' }, { ctx: ctx() });
    await kb({ question: 'a different, longer question?' }, { ctx: ctx() });

    expect(seen).toHaveLength(6);
    for (const request of seen) expect(request.promptCache).toEqual({});
    const stable = seen.map((request) =>
      typeof request.system === 'object' ? request.system.stable : undefined,
    );
    // The prompt's static system and `system().stable`, as ONE block.
    expect(stable[0]).toBe(`${RULES}\n\n${INDEX}`);
    expect(new Set(stable).size).toBe(1);
    // …and the same bytes on the wire: the first system part of all six requests.
    const first = seen.map((request) => JSON.stringify(firstPart(wire(request)[0])));
    expect(new Set(first).size).toBe(1);
    expect(JSON.parse(first[0] ?? '{}')).toEqual({
      type: 'text',
      text: `${RULES}\n\n${INDEX}`,
      cache_control: MARK,
    });
    // The per-run part differs between the runs and sits AFTER the stable one.
    const run = seen.map((request) =>
      typeof request.system === 'object' ? request.system.run : undefined,
    );
    expect(run[0]).toBe('Asked: 6 chars');
    expect(run[3]).toBe('Asked: 29 chars');
  });

  test('the mark moves to the new tail each turn, and turn N+1 still contains turn N’s prefix', async () => {
    const seen = install();
    await declare()({ question: 'q' }, { ctx: ctx() });
    const [one, two, three] = seen.map(wire);
    if (one === undefined || two === undefined || three === undefined) {
      return expect.unreachable('three turns were scripted');
    }
    // system + the tail, and only those: [system, user] → [.., assistant, tool] → [.., assistant, tool]
    expect(markedAt(one)).toEqual([0, 1]);
    expect(markedAt(two)).toEqual([0, 3]);
    expect(markedAt(three)).toEqual([0, 5]);
    // Apart from the mark itself, each request is a strict extension of the one before: the
    // prefix turn N wrote is the prefix turn N+1 sends.
    const unmarked = (messages: unknown) =>
      JSON.parse(JSON.stringify(messages), (key, value) =>
        key === 'cache_control' ? undefined : value,
      ) as { content: unknown }[];
    const text = (message: { content: unknown } | undefined) =>
      JSON.stringify(
        Array.isArray(message?.content) && message.content.length === 1
          ? (message.content[0] as { text?: string }).text
          : message?.content,
      );
    expect(unmarked(two).slice(0, 2).map(text)).toEqual(unmarked(one).map(text));
    expect(unmarked(three).slice(0, 4).map(text)).toEqual(unmarked(two).map(text));
  });

  test('the same transcript on the Anthropic wire never exceeds four breakpoints', async () => {
    const seen = install();
    await declare()({ question: 'q' }, { ctx: ctx() });
    registerModel({
      id: 'claude-sonnet-5-5',
      contextWindow: 1_000_000,
      maxOutput: 128_000,
      inputPerMillion: usd(200),
      outputPerMillion: usd(1_000),
      cacheMinimumTokens: 512,
      reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
    });
    const native = anthropicProvider({ models: ['claude-sonnet-5-5'], apiKey: 'k' });
    for (const request of seen) {
      const body = JSON.stringify(native.body({ ...request, model: 'claude-sonnet-5-5' }));
      const count = body.split('"cache_control"').length - 1;
      expect(count).toBeGreaterThanOrEqual(2);
      expect(count).toBeLessThanOrEqual(4);
    }
  });

  test("promptCache: 'off' sends no hint; a session key is carried on every turn", async () => {
    const seen = install();
    await declare({ promptCache: 'off' })({ question: 'q' }, { ctx: ctx() });
    for (const request of seen) expect(request.promptCache).toBeUndefined();
    expect(markedAt(wire(seen[2] ?? expect.unreachable('three turns')))).toEqual([]);

    const keyed = install();
    await declare({
      promptCache: {
        session: ({ ctx: c }) => `kb:${c.actor.kind === 'user' ? c.actor.orgId : ''}`,
      },
    })({ question: 'q' }, { ctx: ctx() });
    expect(keyed.map((request) => request.promptCache?.session)).toEqual([
      'kb:org-1',
      'kb:org-1',
      'kb:org-1',
    ]);
  });

  test('an agent with no system() and no per-run part still sends its system as one string', async () => {
    const seen = install();
    await declare({}, [], false)({ question: 'q' }, { ctx: ctx() });
    expect(seen[0]?.system).toBe(RULES);
  });
});

describe('usage and cost, per turn and per run', () => {
  test('onTurn reports cache reads and writes, priced at the cache rates, and the running total', async () => {
    install();
    const turns: AgentTurn[] = [];
    await declare({}, turns)({ question: 'q' }, { ctx: ctx() });

    expect(turns.map((turn) => turn.usage.cacheWriteTokens)).toEqual([6_000, 300, 300]);
    expect(turns.map((turn) => turn.usage.cacheReadTokens)).toEqual([0, 6_000, 6_300]);
    // Turn 1: 20 in @200 + 6,000 written @250 + 30 out @1,000 per million = 0.004 + 1.5 + 0.03
    // = 1.534 minor units, rounded up ONCE (it read 3 while each half was rounded on its own).
    expect(turns[0]?.cost).toEqual(usd(2));
    // Turn 2: 10 in + 6,000 READ @10 + 300 written + 30 out = 0.002 + 0.06 + 0.075 + 0.03 → 1.
    expect(turns[1]?.cost).toEqual(usd(1));
    // The run: summed usage, priced once — never three round-ups added together.
    const last = turns.at(-1)?.run;
    expect(last?.usage).toEqual({
      inputTokens: 40,
      outputTokens: 100,
      cacheReadTokens: 12_300,
      cacheWriteTokens: 6_600,
    });
    // 40@200 + 12,300@10 + 6,600@250 + 100@1,000 = 0.008 + 0.123 + 1.65 + 0.1 = 1.881 → 2.
    expect(last?.cost).toEqual(usd(2));
    expect(turns[0]?.run.usage).toEqual(turns[0]?.usage as TokenUsage);
  });

  test('the same run without a cache would have cost the prefix at the input rate every turn', () => {
    register();
    const cached = costOf(MODEL, {
      inputTokens: 40,
      outputTokens: 0,
      cacheReadTokens: 12_300_000,
      cacheWriteTokens: 6_600_000,
    });
    const uncached = costOf(MODEL, {
      inputTokens: 18_900_040,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    // 12.3M read @10 + 6.6M written @250 = 123 + 1,650; against 18.9M @200 = 3,780.
    expect(cached.minor).toBe(1_774);
    expect(uncached.minor).toBe(3_781);
  });
});
