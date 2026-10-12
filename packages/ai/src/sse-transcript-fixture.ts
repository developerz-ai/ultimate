// SSE transcripts as an OpenAI-format gateway really sends them, and a `fetch` that replays one in
// network-sized pieces. Shared by the suites that drive a provider over a streamed tool call. Not
// shipped (`!src/**/*-fixture.ts`).
//
// The shapes are OpenRouter's, read off a captured run (`anthropic/claude-sonnet-5.5`, 2026-10-11,
// 288 frames): `: OPENROUTER PROCESSING` comments while the upstream model is silent (58 of them),
// `reasoning` deltas the request never asked for BEFORE the call, `tool_calls` deltas whose first
// fragment carries the id and the name with empty arguments, a finish chunk, then ONE trailing
// chunk that carries `usage` and REPEATS the finish reason, then `[DONE]`.

import type { AiFetch } from './fetch-seam';

export interface ScriptedCall {
  readonly index?: number;
  readonly id: string;
  readonly name: string;
  /** The argument string, exactly as the model wrote it — parseable or not. */
  readonly args: string;
}

export interface TranscriptInput {
  readonly model: string;
  readonly calls: readonly ScriptedCall[];
  readonly finish: 'tool_calls' | 'length' | 'stop';
  /** Characters of argument text per delta. Small on purpose: escapes and code points get split. */
  readonly slice?: number;
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
  /** Emit a keep-alive comment before the first delta and between every few. */
  readonly keepAlive?: boolean;
}

export const KEEP_ALIVE = ': OPENROUTER PROCESSING\n\n';

const chunk = (model: string, choice: Record<string, unknown>, extra: object = {}): string =>
  `data: ${JSON.stringify({
    id: 'gen-1760180000-a1B2c3',
    provider: 'Anthropic',
    model,
    object: 'chat.completion.chunk',
    created: 1_760_180_000,
    choices: [{ index: 0, logprobs: null, native_finish_reason: null, ...choice }],
    ...extra,
  })}\n\n`;

/** One streamed completion as text: what the socket carries, frame boundaries and all. */
export function transcript(input: TranscriptInput): string {
  const size = input.slice ?? 11;
  let text = input.keepAlive === true ? KEEP_ALIVE + KEEP_ALIVE : '';
  text += chunk(input.model, {
    delta: { role: 'assistant', content: '', reasoning: 'I need to plan the sections ' },
    finish_reason: null,
  });
  input.calls.forEach((call, position) => {
    const index = call.index ?? position;
    text += chunk(input.model, {
      delta: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
        ],
      },
      finish_reason: null,
    });
    for (let at = 0; at < call.args.length; at += size) {
      if (input.keepAlive === true && at % (size * 5) === 0) text += KEEP_ALIVE;
      text += chunk(input.model, {
        delta: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { index, type: 'function', function: { arguments: call.args.slice(at, at + size) } },
          ],
        },
        finish_reason: null,
      });
    }
  });
  text += chunk(input.model, {
    delta: { role: 'assistant', content: '' },
    finish_reason: input.finish,
    native_finish_reason: input.finish === 'length' ? 'max_tokens' : 'tool_use',
  });
  if (input.usage !== undefined) {
    text += chunk(
      input.model,
      // The captured run repeats the reason here: a reader that closed its calls at the FIRST
      // reason must not close (or emit) them again at the second.
      { delta: { role: 'assistant', content: '' }, finish_reason: input.finish },
      { usage: { ...input.usage, total_tokens: 0, cost: 0.0421 } },
    );
  }
  return `${text}data: [DONE]\n\n`;
}

/** A streamed 200 that delivers `text` in reads of `bytes` — cut wherever the count falls. */
export function streamed(text: string, bytes = 7): Response {
  const encoded = new TextEncoder().encode(text);
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= encoded.length) return controller.close();
      controller.enqueue(encoded.slice(at, at + bytes));
      at += bytes;
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A `fetch` answering every request with the same transcript, counting how often it was asked. */
export function replaying(text: string, bytes = 7): { fetch: AiFetch; calls: () => number } {
  let calls = 0;
  return {
    fetch: () => {
      calls += 1;
      return Promise.resolve(streamed(text, bytes));
    },
    calls: () => calls,
  };
}
