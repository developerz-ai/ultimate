// Shared fixtures for the Anthropic provider suites: a recording fetch, a real SSE body, and the
// canonical event sequence. Here rather than duplicated because `provider.test.ts` and
// `provider-stream.test.ts` assert on the same wire and must not drift apart.
import type { AiFetch } from './fetch-seam';
import type { StreamChunk } from './provider';

export interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

/** Records what left the process and replies with whatever the test wants back. */
export function fakeFetch(calls: Call[], reply: (call: Call, index: number) => Response): AiFetch {
  return async (input, init) => {
    const call: Call = {
      url: input,
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  };
}

/** A real SSE body — the provider reads it through the same framing a socket would deliver. */
export function sseResponse(events: readonly Record<string, unknown>[]): Response {
  const text = events
    .map((event) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

export const STREAM_EVENTS: readonly Record<string, unknown>[] = [
  {
    type: 'message_start',
    message: { id: 'msg_1', model: 'claude-opus-5', usage: { input_tokens: 100 } },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ship ' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 25 } },
  { type: 'message_stop' },
];

export async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const seen: StreamChunk[] = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
}
