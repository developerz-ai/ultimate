/**
 * A streamed tool call, end to end over the socket's own framing. Above `STREAM_ONLY_MAX_TOKENS`
 * `generate()` runs the streaming transport, so this is the path a long structured answer takes.
 *
 * The failure first, as an unattended job met it: one streamed article came back as tool
 * arguments that would not parse, and that surfaced as `X_AI_PROVIDER_UNAVAILABLE` — the one code
 * this package classifies RETRYABLE — with the tokens billed and the ledger told nothing. Two
 * different events hide behind "would not parse", and neither is a provider being unavailable:
 * the answer was CUT OFF mid-arguments (truncation), or the model really wrote broken JSON.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { anonymousCtx } from '@ultimat3/action';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { billedOf } from './billed';
import { BudgetLedger, withBudget } from './budget';
import { providerGateway } from './gateway';
import { llm } from './llm';
import { useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import { definePrompt } from './prompt';
import { anthropicProvider } from './provider';
import { sseResponse } from './provider-fixture';
import { configureAi, resetAiRuntime } from './runtime';
import type { ScriptedCall } from './sse-transcript-fixture';
import { replaying, transcript } from './sse-transcript-fixture';

useFixtureModels();

const MODEL = 'gpt-5.6-sol';
const USAGE = { prompt_tokens: 2_100, completion_tokens: 6_400 };

/** A long article: quotes, backslashes, newlines, an astral code point and accented text. */
const ARTICLE = {
  title: 'Notificación "personal": art. 8 \\ Ley 2213',
  body: `${'Párrafo con «comillas», una barra \\ y un salto\nde línea. 🧾 '.repeat(120)}fin`,
  tags: ['notificación', 'juzgado'],
};
const respond = (args: string, extra: Partial<ScriptedCall> = {}): ScriptedCall => ({
  id: 'toolu_01A9',
  name: 'respond',
  args,
  ...extra,
});

function provider(text: string, bytes?: number) {
  const replay = replaying(text, bytes);
  return {
    replay,
    provider: openAiProvider({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [MODEL],
      fetch: replay.fetch,
    }),
  };
}

const request = (name = 'respond') => ({
  model: MODEL,
  messages: [{ role: 'user' as const, content: 'write it' }],
  // Above the ceiling, so `generate()` is the streaming transport.
  maxTokens: 20_000,
  tools: [{ name, description: 'd', input_schema: { type: 'object' as const } }],
});

beforeEach(() => {
  resetAiRuntime();
});

describe('a long streamed tool call parses', () => {
  for (const bytes of [1, 7, 4_096]) {
    test(`with keep-alive comments, split escapes and trailing usage, read ${bytes} bytes at a time`, async () => {
      const text = transcript({
        model: MODEL,
        calls: [respond(JSON.stringify(ARTICLE))],
        finish: 'tool_calls',
        usage: USAGE,
        keepAlive: true,
        slice: 5,
      });
      const result = await provider(text, bytes).provider.generate(request());

      expect(result.stopReason).toBe('tool_use');
      expect(result.toolCalls).toEqual([{ id: 'toolu_01A9', name: 'respond', input: ARTICLE }]);
      expect(result.usage).toMatchObject({ inputTokens: 2_100, outputTokens: 6_400 });
    });
  }

  // Gateways in this family that translate another vendor's stream number every call `0` and
  // tell them apart by id alone. Merged by index, two calls became one string — `{…}{…}` — which
  // is not JSON, so two well-formed calls were reported as one unparseable one.
  test('two calls that share one index are two calls, told apart by their ids', async () => {
    const text = transcript({
      model: MODEL,
      calls: [
        { index: 0, id: 'call_a', name: 'readDoc', args: '{"id":"a"}' },
        { index: 0, id: 'call_b', name: 'readDoc', args: '{"id":"b"}' },
      ],
      finish: 'tool_calls',
      usage: USAGE,
    });
    const result = await provider(text).provider.generate(request('readDoc'));

    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'readDoc', input: { id: 'a' } },
      { id: 'call_b', name: 'readDoc', input: { id: 'b' } },
    ]);
  });

  test('an id repeated on every fragment is still one call', async () => {
    const frame = (args: string) =>
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call_a', function: { name: '', arguments: args } }],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`;
    const text =
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'readDoc', arguments: '' } }] } }] })}\n\n` +
      frame('{"id"') +
      frame(':"a"}') +
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE })}\n\n` +
      'data: [DONE]\n\n';
    const result = await provider(text).provider.generate(request('readDoc'));
    expect(result.toolCalls).toEqual([{ id: 'call_a', name: 'readDoc', input: { id: 'a' } }]);
  });

  // The finish reason and the last argument fragment are separate frames, and nothing in the
  // format orders them: the call is read when the STREAM ends, not when the reason arrives.
  test('an argument fragment that lands after the finish reason still belongs to its call', async () => {
    const delta = (tool: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: tool, finish_reason: finish }] })}\n\n`;
    const text =
      delta({
        tool_calls: [{ index: 0, id: 'c', function: { name: 'readDoc', arguments: '{"id":' } }],
      }) +
      delta({}, 'tool_calls') +
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }) +
      `data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\ndata: [DONE]\n\n`;
    const result = await provider(text).provider.generate(request('readDoc'));
    expect(result.toolCalls).toEqual([{ id: 'c', name: 'readDoc', input: { id: 'a' } }]);
  });
});

describe('a streamed tool call cut off at the output ceiling', () => {
  const cut = JSON.stringify(ARTICLE).slice(0, 900);

  test('is a truncated answer with no call in it, never a transport failure', async () => {
    const text = transcript({
      model: MODEL,
      calls: [respond(cut)],
      finish: 'length',
      usage: USAGE,
    });
    const result = await provider(text).provider.generate(request());

    expect(result.stopReason).toBe('max_tokens');
    // A fragment is never a call.
    expect(result.toolCalls).toEqual([]);
    expect(result.usage).toMatchObject({ inputTokens: 2_100, outputTokens: 6_400 });
  });

  test('reaches llm() as X_LLM_TRUNCATED, is asked for ONCE, and the ledger holds what it cost', async () => {
    const text = transcript({
      model: MODEL,
      calls: [respond(cut)],
      finish: 'length',
      usage: USAGE,
    });
    const { provider: endpoint, replay } = provider(text);
    configureAi({ gateway: providerGateway({ providers: [endpoint], defaultModel: MODEL }) });
    const write = llm({
      input: t.object({ topic: t.string }),
      output: t.object({ title: t.string, body: t.string, tags: t.array(t.string) }),
      prompt: definePrompt<{ topic: string }>({
        id: 'streamed-cut',
        version: '1.0.0',
        template: 'Write about {{topic}}.',
      }),
      vars: ({ input }) => ({ topic: input.topic }),
      policy: allow(),
      maxTokens: 20_000,
    }).named('streamedCut');

    const ledger = new BudgetLedger({ limits: {} });
    const outcome = await withBudget(ledger, () =>
      write({ topic: 'tides' }, { ctx: anonymousCtx() }),
    ).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: 'X_LLM_TRUNCATED' });
    expect(replay.calls()).toBe(1);
    expect((await ledger.report()).requestTokens).toBe(8_500);
  });
});

describe('a streamed tool call whose arguments really are not JSON', () => {
  const broken = '{"title":"ok","body":"an unescaped " quote"}';
  const text = () =>
    transcript({ model: MODEL, calls: [respond(broken)], finish: 'tool_calls', usage: USAGE });

  test('is X_LLM_TOOL_ARGUMENTS_INVALID carrying what was billed — not the retryable code', async () => {
    const outcome = await provider(text())
      .provider.generate(request())
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({
      code: 'X_LLM_TOOL_ARGUMENTS_INVALID',
      meta: { provider: 'openai', model: MODEL, tool: 'respond' },
    });
    expect(billedOf(outcome)).toMatchObject({
      usage: { inputTokens: 2_100, outputTokens: 6_400 },
      calls: 1,
      unsettled: 0,
    });
    // Never the model's text: an argument string is where a prompt's data ends up.
    expect(String((outcome as Error).message)).not.toContain('unescaped');
  });

  test('the gateway asks once, and records the bill instead of releasing the reservation', async () => {
    const { provider: endpoint, replay } = provider(text());
    const gateway = providerGateway({ providers: [endpoint], defaultModel: MODEL });
    const ledger = new BudgetLedger({ limits: {} });

    const outcome = await withBudget(ledger, () => gateway.generate(request())).catch(
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({ code: 'X_LLM_TOOL_ARGUMENTS_INVALID' });
    expect(replay.calls()).toBe(1);
    const report = await ledger.report();
    expect(report.requestTokens).toBe(8_500);
    expect(report.cost.minor).toBeGreaterThan(0);
  });

  test('the non-streamed read makes the same two calls', async () => {
    const body = (finish: string) => ({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c', function: { name: 'respond', arguments: broken } }],
          },
          finish_reason: finish,
        },
      ],
      usage: USAGE,
    });
    const over = (finish: string) =>
      openAiProvider({
        apiKey: 'k',
        models: [MODEL],
        fetch: () => Promise.resolve(new Response(JSON.stringify(body(finish)))),
      }).generate({ ...request(), maxTokens: 1_000 });

    await expect(over('tool_calls')).rejects.toMatchObject({
      code: 'X_LLM_TOOL_ARGUMENTS_INVALID',
    });
    expect(await over('length')).toMatchObject({ stopReason: 'max_tokens', toolCalls: [] });
  });
});

describe('the Anthropic wire draws the same line', () => {
  const events = (partial: string, stop: string) => [
    { type: 'message_start', message: { usage: { input_tokens: 2_100 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'respond', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: partial },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 6_400 } },
    { type: 'message_stop' },
  ];
  const over = (partial: string, stop: string) =>
    anthropicProvider({
      apiKey: 'k',
      models: ['claude-opus-5'],
      fetch: () => Promise.resolve(sseResponse(events(partial, stop))),
    }).generate({ ...request(), model: 'claude-opus-5' });

  test('cut off mid-arguments is a truncated answer with no call', async () => {
    expect(await over('{"title":"Notif', 'max_tokens')).toMatchObject({
      stopReason: 'max_tokens',
      toolCalls: [],
      usage: { inputTokens: 2_100, outputTokens: 6_400 },
    });
  });

  test('broken JSON on a finished turn is the typed error, with its bill', async () => {
    const outcome = await over('{"title":"a" "b"}', 'tool_use').catch((error: unknown) => error);
    expect(outcome).toMatchObject({
      code: 'X_LLM_TOOL_ARGUMENTS_INVALID',
      meta: { provider: 'anthropic', tool: 'respond' },
    });
    expect(billedOf(outcome)?.usage).toMatchObject({ inputTokens: 2_100, outputTokens: 6_400 });
  });
});
