/**
 * What LEAVES the process when a request carries a prompt-cache hint — one golden request per rule
 * in `PROMPT_CACHE_RULES` on the chat-completions wire, asserted on the body and headers the socket
 * is handed. The Anthropic wire and the pre-flight estimate are `prompt-cache-blocks.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { openAiProvider } from './openai-provider';
import { OPENAI_CACHE_KEY_MAX, promptCacheRule, SESSION_KEY_MAX, systemText } from './prompt-cache';
import {
  CHAT_REPLY,
  CLAUDE,
  capture,
  GEMINI,
  GPT,
  MARK,
  marks,
  NATIVE,
  openRouter,
  RUN,
  register,
  STABLE,
  transcript,
} from './prompt-cache-fixture';
import type { GenerateRequest } from './provider';

describe('the rule table', () => {
  test('first match wins, per wire, host and model prefix', () => {
    const rule = (wire: 'anthropic' | 'openai', url: string | undefined, model: string) => {
      const { marks, session } = promptCacheRule(wire, url, model);
      return [marks, session];
    };
    expect(rule('anthropic', undefined, NATIVE)).toEqual(['blocks', 'none']);
    expect(rule('openai', 'https://openrouter.ai/api/v1', CLAUDE)).toEqual([
      'parts',
      'x-session-id',
    ]);
    expect(rule('openai', 'https://openrouter.ai/api/v1', GEMINI)).toEqual([
      'none',
      'x-session-id',
    ]);
    expect(rule('openai', undefined, GPT)).toEqual(['none', 'prompt_cache_key']);
    expect(rule('openai', 'https://api.openai.com/v1', GPT)).toEqual(['none', 'prompt_cache_key']);
    // An endpoint the table has never heard of gets nothing it might reject.
    expect(rule('openai', 'http://vllm:8000/v1', 'acme-70b')).toEqual(['none', 'none']);
    // A look-alike host is not the host.
    expect(rule('openai', 'https://openrouter.ai.evil.test/v1', CLAUDE)).toEqual(['none', 'none']);
    expect(rule('openai', 'not a url', CLAUDE)).toEqual(['none', 'none']);
  });

  test('the two system parts read as one text, stable first', () => {
    expect(systemText(undefined)).toBe('');
    expect(systemText('s')).toBe('s');
    expect(systemText({ stable: 'a', run: 'b' })).toBe('a\n\nb');
    expect(systemText({ stable: 'a' })).toBe('a');
    expect(systemText({ stable: '', run: 'b' })).toBe('b');
  });
});

describe('Anthropic model on OpenRouter (chat-completions wire)', () => {
  test('the stable system part and the tail carry the mark; never more than four', async () => {
    const { body, headers } = await openRouter({
      model: CLAUDE,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['messages']).toEqual([
      {
        role: 'system',
        content: [
          { type: 'text', text: STABLE, cache_control: MARK },
          { type: 'text', text: RUN },
        ],
      },
      { role: 'user', content: 'Resolve order 7.' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":"7"}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [{ type: 'text', text: 'shipped', cache_control: MARK }],
      },
    ]);
    expect(marks(body)).toBe(2);
    expect(marks(body)).toBeLessThanOrEqual(4);
    // No key, no session; and routing is never steered.
    expect(headers['x-session-id']).toBeUndefined();
    expect(body['session_id']).toBeUndefined();
    expect(body['provider']).toBeUndefined();
    expect(body['prompt_cache_key']).toBeUndefined();
    expect(body['usage']).toBeUndefined();
  });

  test('a plain-string system is one marked part; a prose tail is marked as a part', async () => {
    const { body } = await openRouter({
      model: CLAUDE,
      system: STABLE,
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['messages']).toEqual([
      { role: 'system', content: [{ type: 'text', text: STABLE, cache_control: MARK }] },
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: MARK }] },
    ]);
  });

  test('a session key rides the x-session-id header, and only with a key', async () => {
    const request: GenerateRequest = {
      model: CLAUDE,
      system: STABLE,
      messages: transcript,
      maxTokens: 100,
    };
    const keyed = await openRouter({ ...request, promptCache: { session: 'kb-agent:org-1' } });
    expect(keyed.headers['x-session-id']).toBe('kb-agent:org-1');
    expect(keyed.body['prompt_cache_key']).toBeUndefined();
    const bare = await openRouter({ ...request, promptCache: {} });
    expect(bare.headers['x-session-id']).toBeUndefined();
  });

  test('no hint, no mark: the request is byte-for-byte what it was', async () => {
    const { body, headers } = await openRouter({
      model: CLAUDE,
      system: STABLE,
      messages: transcript,
      maxTokens: 100,
    });
    expect(marks(body)).toBe(0);
    expect((body['messages'] as unknown[])[0]).toEqual({ role: 'system', content: STABLE });
    expect(headers['x-session-id']).toBeUndefined();
  });

  test('a session key over the host limit is refused before the socket', async () => {
    register();
    const { sent, fetch } = capture(CHAT_REPLY);
    const provider = openAiProvider({
      apiKey: 'k',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: [CLAUDE],
      fetch,
    });
    const call = provider.generate({
      model: CLAUDE,
      messages: transcript,
      maxTokens: 100,
      promptCache: { session: 'x'.repeat(SESSION_KEY_MAX + 1) },
    });
    await expect(call).rejects.toMatchObject({ code: 'X_AI_REQUEST_INVALID' });
    expect(sent).toHaveLength(0);
  });
});

describe('a non-Anthropic model on OpenRouter', () => {
  test('Gemini gets NO explicit mark — it would turn free implicit caching into a paid write', async () => {
    const { body, headers } = await openRouter({
      model: GEMINI,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 100,
      promptCache: { session: 's-1' },
    });
    expect(marks(body)).toBe(0);
    // One string, stable half FIRST: implicit caching is a prefix match.
    expect((body['messages'] as unknown[])[0]).toEqual({
      role: 'system',
      content: `${STABLE}\n\n${RUN}`,
    });
    expect((body['messages'] as unknown[]).at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'shipped',
    });
    // Stickiness is the host's, whatever the model: implicit caches are per upstream too.
    expect(headers['x-session-id']).toBe('s-1');
    expect(body['provider']).toBeUndefined();
  });
});

describe('OpenAI direct', () => {
  test('a session key is prompt_cache_key; nothing is marked', async () => {
    const request: GenerateRequest = {
      model: GPT,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 100,
    };
    const keyed = await openRouter(
      { ...request, promptCache: { session: 'kb' } },
      'https://api.openai.com/v1',
    );
    expect(keyed.body['prompt_cache_key']).toBe('kb');
    expect(keyed.headers['x-session-id']).toBeUndefined();
    expect(marks(keyed.body)).toBe(0);
    const bare = await openRouter({ ...request, promptCache: {} }, 'https://api.openai.com/v1');
    expect(bare.body['prompt_cache_key']).toBeUndefined();
  });

  test('a key over 64 characters is hashed for prompt_cache_key — the same key, the same hash', async () => {
    const request: GenerateRequest = { model: GPT, messages: transcript, maxTokens: 100 };
    const long = `tenant:${'a'.repeat(100)}`;
    const send = async (session: string) =>
      (await openRouter({ ...request, promptCache: { session } }, 'https://api.openai.com/v1'))
        .body['prompt_cache_key'] as string;
    const hashed = await send(long);
    expect(hashed).toMatch(/^h:[0-9a-f]{62}$/);
    expect(hashed).toHaveLength(OPENAI_CACHE_KEY_MAX);
    expect(await send(long)).toBe(hashed);
    expect(await send(`${long}b`)).not.toBe(hashed);
    // At the limit, verbatim.
    expect(await send('k'.repeat(OPENAI_CACHE_KEY_MAX))).toBe('k'.repeat(OPENAI_CACHE_KEY_MAX));
    // The same 100+ characters are a legal OpenRouter session id, and travel as written.
    const routed = await openRouter({ ...request, model: GEMINI, promptCache: { session: long } });
    expect(routed.headers['x-session-id']).toBe(long);
  });

  test('an endpoint the table does not name gets neither mark nor session', async () => {
    const { body, headers } = await openRouter(
      {
        model: CLAUDE,
        system: STABLE,
        messages: transcript,
        maxTokens: 100,
        promptCache: { session: 's' },
      },
      'https://llm.acme.internal/v1',
    );
    expect(marks(body)).toBe(0);
    expect(headers['x-session-id']).toBeUndefined();
    expect(body['prompt_cache_key']).toBeUndefined();
  });
});
