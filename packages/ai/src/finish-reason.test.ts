/**
 * What a chat-completions finish reason MEANS. The failure first: every reason this build did not
 * list read as `max_tokens` — safe while a truncated answer was still validated, and wrong once a
 * truncated turn is refused before it is read: an endpoint that says `eos`, `end_turn` or `STOP`
 * failed every `llm()` call with "double maxTokens". Synonyms are mapped; a reason nobody knows is
 * not truncation — a turn that is whole is a stop, and one that is not is its own typed failure.
 */

import { describe, expect, test } from 'bun:test';
import { billedOf } from './billed';
import { AI_ERROR_RETRY } from './errors-retry';
import { useFixtureModels } from './model-fixture';
import { openAiProvider } from './openai-provider';
import { replaying } from './sse-transcript-fixture';

useFixtureModels();
const MODEL = 'gpt-5.6-sol';
const USAGE = { prompt_tokens: 10, completion_tokens: 5 };
const over = (message: object, finish: string) =>
  openAiProvider({
    apiKey: 'k',
    models: [MODEL],
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ choices: [{ message, finish_reason: finish }], usage: USAGE }),
        ),
      ),
  }).generate({ model: MODEL, messages: [{ role: 'user', content: 'x' }], maxTokens: 100 });
const call = (args: string) => ({
  tool_calls: [{ id: 'c', function: { name: 'respond', arguments: args } }],
});

describe('a finish reason is read for what it means', () => {
  test.each([
    ['stop', 'end_turn'],
    ['end_turn', 'end_turn'],
    ['eos', 'end_turn'],
    ['STOP', 'end_turn'],
    ['stop_sequence', 'stop_sequence'],
    ['length', 'max_tokens'],
    ['max_tokens', 'max_tokens'],
    ['MAX_TOKENS', 'max_tokens'],
    ['content_filter', 'refusal'],
  ])('%s is %s', async (finish, reason) => {
    expect((await over({ content: 'done' }, finish)).stopReason).toBe(reason);
  });

  test.each(['tool_calls', 'function_call', 'tool_use'])('%s is a tool turn', async (finish) => {
    expect((await over(call('{"a":1}'), finish)).stopReason).toBe('tool_use');
  });
});

describe('a reason nobody knows is not truncation', () => {
  test('a whole prose answer is a stop', async () => {
    expect(await over({ content: 'done' }, 'finished_ok')).toMatchObject({
      stopReason: 'end_turn',
      text: 'done',
    });
  });

  test('a whole tool call is a tool turn', async () => {
    expect(await over(call('{"a":1}'), 'finished_ok')).toMatchObject({
      stopReason: 'tool_use',
      toolCalls: [{ name: 'respond', input: { a: 1 } }],
    });
  });

  test('a tool call that does not parse is X_AI_PROVIDER_UNEXPECTED, naming the reason, with its bill', async () => {
    const outcome = await over(call('{"a":'), 'finished_ok').catch((error: unknown) => error);
    expect(outcome).toMatchObject({
      code: 'X_AI_PROVIDER_UNEXPECTED',
      meta: { reason: 'finished_ok' },
    });
    expect(billedOf(outcome)?.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  test('`error` is never an answer', async () => {
    await expect(over({ content: 'half' }, 'error')).rejects.toMatchObject({
      code: 'X_AI_PROVIDER_UNEXPECTED',
    });
  });

  test('streamed, the same reading', async () => {
    const frame = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const text =
      frame({ choices: [{ delta: { content: 'done' } }] }) +
      frame({ choices: [{ delta: {}, finish_reason: 'eos' }], usage: USAGE }) +
      'data: [DONE]\n\n';
    const provider = openAiProvider({ apiKey: 'k', models: [MODEL], fetch: replaying(text).fetch });
    const result = await provider.generate({
      model: MODEL,
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 20_000,
    });
    expect(result).toMatchObject({ stopReason: 'end_turn', text: 'done' });
  });
});

describe('a failure the same input repeats is terminal for a job', () => {
  test.each([
    'X_LLM_TRUNCATED',
    'X_LLM_TOOL_ARGUMENTS_INVALID',
    'X_LLM_OUTPUT_INVALID',
    'X_AGENT_TRANSCRIPT_INVALID',
  ] as const)('%s', (code) => {
    expect(AI_ERROR_RETRY[code as keyof typeof AI_ERROR_RETRY]).toBe('terminal');
  });
});
