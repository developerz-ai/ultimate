/**
 * Compaction through OpenRouter for a model that is not Anthropic's — the host caches it
 * implicitly, so nothing is marked, and the one thing that keeps the cached prefix reachable is
 * sticky routing on `x-session-id`. That header has to be the same on every request of the run,
 * the summary call included, and the system message has to be the same bytes before and after.
 * Driven end to end through `openAiProvider()`: the headers asserted are the ones the socket got.
 */

import { describe, expect, test } from 'bun:test';
import { SUMMARY_INSTRUCTION } from './agent-compact';
import type { AgentCompaction } from './agent-compact-def';
import { ctx, declare, INPUT, registerCompactModels } from './agent-compact-fixture';
import { providerGateway } from './gateway';
import { useFixtureModels } from './model-fixture';
import { registerModel } from './models';
import { openAiProvider } from './openai-provider';
import { configureAi, resetAiRuntime } from './runtime';

useFixtureModels();

const DEEPSEEK = 'deepseek/deepseek-v3.2';
const OPENROUTER = 'https://openrouter.ai/api/v1';
/** The instruction's opening words, as they appear inside the JSON body. */
const INSTRUCTION = SUMMARY_INSTRUCTION.slice(0, 40);

interface Sent {
  readonly headers: Record<string, string>;
  readonly body: { messages: unknown[]; tools?: unknown };
  readonly summary: boolean;
}

/** OpenRouter as the socket sees it: tool calls by position, a summary when asked for one. */
function openRouter(reads: number): Sent[] {
  const sent: Sent[] = [];
  let turns = 0;
  const fetch = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as Sent['body'];
    const summary = JSON.stringify(body.messages.at(-1)).includes(INSTRUCTION);
    sent.push({ headers: { ...(init.headers as Record<string, string>) }, body, summary });
    const usage = {
      prompt_tokens: 1_000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: sent.length > 1 ? 800 : 0 },
    };
    if (summary) {
      return Response.json({
        choices: [{ message: { content: 'SUMMARY: read the tide pages.' }, finish_reason: 'stop' }],
        usage,
      });
    }
    turns += 1;
    const call =
      turns <= reads
        ? { name: 'readDoc', arguments: '{"id":"kb"}' }
        : { name: 'respond', arguments: '{"title":"Tides"}' };
    return Response.json({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: `c${turns}`, type: 'function', function: call }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
  };
  resetAiRuntime();
  registerCompactModels();
  registerModel({
    id: DEEPSEEK,
    contextWindow: 3_000,
    maxOutput: 1_000,
    inputPerMillion: { minor: 28, currency: 'USD' },
    outputPerMillion: { minor: 42, currency: 'USD' },
    cacheReadPerMillion: { minor: 3, currency: 'USD' },
    cacheMinimumTokens: 0,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
  const provider = openAiProvider({ apiKey: 'k', baseUrl: OPENROUTER, models: [DEEPSEEK], fetch });
  configureAi({ gateway: providerGateway({ providers: [provider], defaultModel: DEEPSEEK }) });
  return sent;
}

describe('compaction on OpenRouter, a DeepSeek model', () => {
  test('x-session-id is the same on every request, the summary call included; nothing is marked', async () => {
    const sent = openRouter(7);
    const events: AgentCompaction[] = [];
    const run = await declare(
      { model: DEEPSEEK, compact: { keepTurns: 2 }, promptCache: { session: 'kb-run-7' } },
      events,
    ).run(INPUT, { ctx: ctx() });

    expect(run.output).toEqual({ title: 'Tides' });
    expect(events.some((event) => event.outcome === 'compacted')).toBe(true);
    expect(sent.some((request) => request.summary)).toBe(true);
    for (const request of sent) {
      expect(request.headers['x-session-id']).toBe('kb-run-7');
      // Implicit caching: a mark on this host would be a paid write, or a 400.
      expect(JSON.stringify(request.body)).not.toContain('cache_control');
      // The prefix the host matches on: the system message and the tool list, the same bytes.
      expect(JSON.stringify(request.body.messages[0])).toBe(
        JSON.stringify(sent[0]?.body.messages[0]),
      );
      expect(JSON.stringify(request.body.tools)).toBe(JSON.stringify(sent[0]?.body.tools));
    }
    // The host's cache reads are counted, the summary call's included.
    const summarised = events.find((event) => event.outcome === 'compacted');
    expect(summarised?.usage?.cacheReadTokens).toBe(800);
  });

  test("promptCache: 'auto' sends no session at all, before or after a compaction", async () => {
    const sent = openRouter(7);
    await declare({ model: DEEPSEEK, compact: { keepTurns: 2 } })(INPUT, { ctx: ctx() });
    expect(sent.some((request) => request.summary)).toBe(true);
    for (const request of sent) expect(request.headers['x-session-id']).toBeUndefined();
  });
});
