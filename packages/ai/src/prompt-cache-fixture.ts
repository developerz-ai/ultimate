// What the two prompt-cache wire suites share: the rows they register, one transcript, and a fetch
// that records what the socket was handed. Not shipped (`!src/**/*-fixture.ts`).

import { expect } from 'bun:test';
import { registerModel } from './models';
import { openAiProvider } from './openai-provider';
import type { GenerateRequest } from './provider';

export const usd = (minor: number) => ({ minor, currency: 'USD' });
export const ROW = {
  contextWindow: 200_000,
  maxOutput: 8_000,
  inputPerMillion: usd(300),
  outputPerMillion: usd(1_500),
  cacheMinimumTokens: 1_024,
  reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
} as const;
export const CLAUDE = 'anthropic/claude-sonnet-5.5';
export const GEMINI = 'google/gemini-2.5-flash';
export const GPT = 'gpt-5.6-luna';
export const NATIVE = 'claude-sonnet-5-5';

export function register(): void {
  for (const id of [CLAUDE, GEMINI, GPT, NATIVE]) registerModel({ id, ...ROW });
}

export const MARK = { type: 'ephemeral' };
export const STABLE = 'You are the firm’s assistant. RULES…';
export const RUN = 'Today is 2026-10-11.';

/** A three-message transcript: the shape turn 2 of a tool loop sends. */
export const transcript: GenerateRequest['messages'] = [
  { role: 'user', content: 'Resolve order 7.' },
  {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call-1', name: 'lookup', input: { id: '7' } }],
  },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'shipped' }] },
];

export interface Sent {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export function capture(reply: unknown): { sent: Sent[]; fetch: typeof fetch } {
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

export const CHAT_REPLY = {
  choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1 },
};

export async function openRouter(
  request: GenerateRequest,
  baseUrl = 'https://openrouter.ai/api/v1',
) {
  register();
  const { sent, fetch } = capture(CHAT_REPLY);
  const provider = openAiProvider({ apiKey: 'k', baseUrl, models: [CLAUDE, GEMINI, GPT], fetch });
  await provider.generate(request);
  const only = sent[0];
  if (only === undefined) return expect.unreachable('no request was sent');
  return only;
}

/** Every `cache_control` anywhere in a body — the count a vendor caps at four. */
export function marks(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + marks(item), 0);
  if (typeof value !== 'object' || value === null) return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === 'cache_control' ? 1 : marks(child)),
    0,
  );
}
