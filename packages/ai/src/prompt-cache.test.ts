/**
 * What LEAVES the process when a request carries a prompt-cache hint — one golden request per rule
 * in `PROMPT_CACHE_RULES`, asserted on the body and headers the socket is handed.
 */

import { describe, expect, test } from 'bun:test';
import { registerModel } from './models';
import { openAiProvider } from './openai-provider';
import { promptCacheRule, SESSION_KEY_MAX, systemText } from './prompt-cache';
import type { GenerateRequest } from './provider';
import { anthropicProvider, estimateCost } from './provider';

const usd = (minor: number) => ({ minor, currency: 'USD' });
const ROW = {
  contextWindow: 200_000,
  maxOutput: 8_000,
  inputPerMillion: usd(300),
  outputPerMillion: usd(1_500),
  cacheMinimumTokens: 1_024,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
} as const;
const CLAUDE = 'anthropic/claude-sonnet-5.5';
const GEMINI = 'google/gemini-2.5-flash';
const GPT = 'gpt-5.6-luna';
const NATIVE = 'claude-sonnet-5-5';

function register(): void {
  for (const id of [CLAUDE, GEMINI, GPT, NATIVE]) registerModel({ id, ...ROW });
}

const MARK = { type: 'ephemeral' };
const STABLE = 'You are the firm’s assistant. RULES…';
const RUN = 'Today is 2026-10-11.';

/** A three-message transcript: the shape turn 2 of a tool loop sends. */
const transcript: GenerateRequest['messages'] = [
  { role: 'user', content: 'Resolve order 7.' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: '7' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'shipped' }] },
];

interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function capture(reply: unknown): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  return { sent, fetch: fake };
}

const CHAT_REPLY = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
};

async function openRouter(request: GenerateRequest, baseUrl = 'https://openrouter.ai/api/v1') {
  register();
  const { sent, fetch } = capture(CHAT_REPLY);
  const provider = openAiProvider({ apiKey: 'k', baseUrl, models: [CLAUDE, GEMINI, GPT], fetch });
  await provider.generate(request);
  const only = sent[0];
  if (only === undefined) return expect.unreachable('no request was sent');
  return only;
}

/** Every `cache_control` anywhere in a body — the count a vendor caps at four. */
function marks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + marks(item), 0);
  if (typeof value !== 'object' || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === 'cache_control' ? 1 : marks(child)),
    0,
  );
}

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

describe('Anthropic Messages wire', () => {
  const provider = () => {
    register();
    return anthropicProvider({ models: [NATIVE], apiKey: 'k' });
  };

  test('the stable system block and the last block of the last two messages; three marks', () => {
    const body = provider().body({
      model: NATIVE,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 100,
      promptCache: { session: 'ignored-here' },
    });
    expect(body['system']).toEqual([
      { type: 'text', text: STABLE, cache_control: MARK },
      { type: 'text', text: RUN },
    ]);
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Resolve order 7.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call-1',
            name: 'lookup',
            input: { id: '7' },
            cache_control: MARK,
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'shipped', cache_control: MARK },
        ],
      },
    ]);
    expect(marks(body)).toBe(3);
  });

  test('a one-message request marks it once; a string message becomes one marked block', () => {
    const body = provider().body({
      model: NATIVE,
      system: STABLE,
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['system']).toEqual([{ type: 'text', text: STABLE, cache_control: MARK }]);
    expect(body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello', cache_control: MARK }] },
    ]);
    expect(marks(body)).toBe(2);
  });

  test('no hint: a string system stays a string, two parts are two unmarked blocks', () => {
    const plain = provider().body({
      model: NATIVE,
      system: STABLE,
      messages: transcript,
      maxTokens: 9,
    });
    expect(plain['system']).toBe(STABLE);
    expect(marks(plain)).toBe(0);
    const parts = provider().body({
      model: NATIVE,
      system: { stable: STABLE, run: RUN },
      messages: transcript,
      maxTokens: 9,
    });
    expect(parts['system']).toEqual([
      { type: 'text', text: STABLE },
      { type: 'text', text: RUN },
    ]);
    expect(marks(parts)).toBe(0);
  });

  test('an empty stable part is never sent as an empty block, and never marked', () => {
    const body = provider().body({
      model: NATIVE,
      system: { stable: '', run: RUN },
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 100,
      promptCache: {},
    });
    expect(body['system']).toEqual([{ type: 'text', text: RUN }]);
    expect(marks(body)).toBe(1);
  });
});

describe('the pre-flight estimate', () => {
  test('a hinted request is priced as a cache WRITE, the dearest the prompt can be billed', () => {
    register();
    const text = 'x'.repeat(4_000_000);
    const request: GenerateRequest = {
      model: NATIVE,
      messages: [{ role: 'user', content: text }],
      maxTokens: 1,
    };
    const plain = estimateCost(request).minor;
    const hinted = estimateCost({ ...request, promptCache: {} }).minor;
    // 1M tokens at 300 minor, then 1.25x; the single output token rounds up to one minor unit.
    expect(plain).toBe(301);
    expect(hinted).toBe(376);
  });
});
