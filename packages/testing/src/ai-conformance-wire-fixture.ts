// The AI suites' subjects' world: two registered models (one per built-in wire) and a `fetch` per
// wire that answers "hello world" as that vendor does — a JSON body, or an SSE stream when the
// request asked for one. Test data, not a price list. Not shipped (`!src/**/*-fixture.ts`).

import type { AiFetch } from '@ultimat3/ai';
import { registerModel } from '@ultimat3/ai';

export const ANTHROPIC_MODEL = 'conformance-claude';
export const OPENAI_MODEL = 'conformance-gpt';

const usd = (minor: number) => ({ minor, currency: 'USD' }) as const;

/** Idempotent: re-registering replaces in place. Call it in a `beforeEach`. */
export function registerConformanceModels(): void {
  const common = {
    contextWindow: 200_000,
    maxOutput: 32_000,
    // One minor unit a token: every call costs whole cents, so two calls booked on one ledger are
    // visibly more than one — at a real price both round up to the same single cent.
    inputPerMillion: usd(1_000_000),
    outputPerMillion: usd(1_000_000),
    cacheMinimumTokens: 1_024,
    input: ['image', 'document'],
  } as const;
  registerModel({
    id: ANTHROPIC_MODEL,
    family: 'anthropic',
    ...common,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
  registerModel({
    id: OPENAI_MODEL,
    family: 'openai',
    ...common,
    reasoning: { effort: false, adaptive: false, disableThinkingUpTo: undefined },
  });
}

const streams = (init: RequestInit): boolean =>
  (JSON.parse(String(init.body ?? '{}')) as { stream?: unknown }).stream === true;

const sse = (frames: readonly string[]): Response =>
  new Response(frames.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const event = (payload: { readonly type: string; readonly [field: string]: unknown }): string =>
  `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;

/** The Messages API answering "hello world". */
export const anthropicHello: AiFetch = async (_url, init) => {
  if (!streams(init)) {
    return json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: ANTHROPIC_MODEL,
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 2 },
    });
  }
  return sse([
    event({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 9 } } }),
    event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello ' } }),
    event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } }),
    event({ type: 'content_block_stop', index: 0 }),
    event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 2 },
    }),
    event({ type: 'message_stop' }),
  ]);
};

const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

/** Chat completions answering "hello world". */
export const openAiHello: AiFetch = async (_url, init) => {
  const usage = { prompt_tokens: 9, completion_tokens: 2 };
  if (!streams(init)) {
    return json({
      choices: [{ message: { role: 'assistant', content: 'hello world' }, finish_reason: 'stop' }],
      usage,
    });
  }
  return sse([
    chunk({ choices: [{ delta: { role: 'assistant', content: 'hello ' }, finish_reason: null }] }),
    chunk({ choices: [{ delta: { content: 'world' }, finish_reason: null }] }),
    chunk({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    chunk({ choices: [], usage }),
    'data: [DONE]\n\n',
  ]);
};
