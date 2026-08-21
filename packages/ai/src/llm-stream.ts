/**
 * The streaming half of `llm()`. Same action, same policy, same budget — one transport swapped.
 *
 * `.stream()` re-enters the action through its ordinary call path, marking the invocation with an
 * ambient sink; `llm.ts` sees the sink and drives `gateway.stream` instead of `gateway.generate`.
 * That is why the policy, the input parse, the audit record, the rate limit, the semantic cache,
 * the span and the manifest row all still apply: there is no second execution path to keep in
 * step, only a second way for the answer to arrive.
 *
 * Two questions a streamed model call forces, both answered here:
 *
 *  1. OUTPUT SCHEMA. A schema cannot be checked until the last token has landed, so a stream
 *     yields UNVALIDATED text and one final `done` carrying the value that DID satisfy `output`.
 *     There is no repair turn: the consumer has already read the tokens, and replaying a second
 *     answer over the top is two answers to one question. One attempt, then
 *     `X_LLM_STREAM_INVALID`, whose fix is the non-streaming call that can repair.
 *  2. BUDGET. Unchanged, and still reserved before the provider is touched: `Gateway.stream`
 *     debits the worst-case estimate on the first pull and reconciles it against real usage at
 *     `done`, releasing it in a `finally` when a stream throws or is abandoned. The whole stream
 *     is driven INSIDE the action's handler, so the reservation and its reconciliation sit on one
 *     async chain — abandoning the iterator stops delivery, never the accounting.
 */

import { asyncContext } from '@ultimat3/core';
import { AiTransportError } from './errors';
import type { Gateway } from './gateway';
import type { GenerateRequest, GenerateResult } from './provider';

/**
 * One increment of a streamed answer. `thinking` is a separate kind on purpose — the wire layer
 * refuses to fold reasoning into `text`, and a consumer concatenating every chunk must not end up
 * shipping it to the user.
 */
export type LlmStreamChunk<T> =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly text: string }
  | { readonly type: 'done'; readonly value: T };

type Resolver = () => void;

/**
 * The buffer between the handler pushing chunks and the caller pulling them. Unbounded: an LLM
 * answer is bounded by `maxTokens` and a slow reader must never stall a call whose budget
 * reservation is already open.
 */
export class LlmSink {
  private readonly queue: LlmStreamChunk<unknown>[] = [];
  private wake: Resolver | undefined;
  private ended = false;
  private failure: unknown;
  private failed = false;
  private abandoned = false;

  emit(chunk: LlmStreamChunk<unknown>): void {
    // A consumer that stopped reading gets nothing more, but the call it authorised runs to
    // completion — half a reconciliation holds a budget ceiling for the rest of the window.
    if (this.abandoned) return;
    this.queue.push(chunk);
    this.release();
  }

  finish(value: unknown): void {
    this.emit({ type: 'done', value });
    this.ended = true;
    this.release();
  }

  fail(error: unknown): void {
    this.failure = error;
    this.failed = true;
    this.ended = true;
    this.release();
  }

  close(): void {
    this.abandoned = true;
    this.queue.length = 0;
    this.release();
  }

  async *drain(): AsyncGenerator<LlmStreamChunk<unknown>> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      // The original throwable, rethrown rather than wrapped: it is already an `UltimateError`
      // with the code, the cause and the fix the caller needs, and re-boxing it loses all three.
      if (this.failed) throw this.failure;
      if (this.ended || this.abandoned) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private release(): void {
    const waiter = this.wake;
    this.wake = undefined;
    waiter?.();
  }
}

// Core's one lazy seam, never a construction here: a module-scope `new` threw at EVALUATION in a
// browser bundle, where the bundler stubs `node:async_hooks` to `{}`.
const sinks = asyncContext<LlmSink>('an LLM stream sink');

/** Mark everything `fn` awaits as a streamed invocation. */
export function withLlmSink<T>(sink: LlmSink, fn: () => Promise<T>): Promise<T> {
  return sinks.run(sink, fn);
}

/** The sink of the streamed invocation this call belongs to, or `undefined` for a plain one. */
export function currentLlmSink(): LlmSink | undefined {
  return sinks.get();
}

/**
 * Turn one invocation into an iterable of chunks. LAZY, like `Gateway.stream`: nothing is
 * authorised, budgeted or sent until the first pull, so a `.stream()` handed to a consumer that
 * never reads it spends nothing and denies nobody.
 */
export function llmStream<T>(run: (sink: LlmSink) => Promise<T>): AsyncIterable<LlmStreamChunk<T>> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<LlmStreamChunk<T>> {
      const sink = new LlmSink();
      // Never rejects — every outcome lands on the sink, which is where the consumer looks.
      void run(sink).then(
        (value) => {
          sink.finish(value);
        },
        (error: unknown) => {
          sink.fail(error);
        },
      );
      try {
        for await (const chunk of sink.drain()) yield chunk as LlmStreamChunk<T>;
      } finally {
        sink.close();
      }
    },
  };
}

/**
 * Drive one streamed turn: forward every increment to the consumer, keep the assembled result.
 *
 * A `tool-call` chunk cannot arrive here — the streaming path offers no tools, precisely so there
 * ARE text deltas to stream — and is dropped rather than thrown on, because a provider that sends
 * one has not broken the answer the `done` chunk carries.
 */
export async function streamOneTurn(
  gateway: Gateway,
  request: GenerateRequest,
  sink: LlmSink,
): Promise<GenerateResult> {
  let assembled: GenerateResult | undefined;
  for await (const chunk of gateway.stream(request)) {
    if (chunk.type === 'text') sink.emit({ type: 'text', text: chunk.text });
    else if (chunk.type === 'thinking') sink.emit({ type: 'thinking', text: chunk.text });
    else if (chunk.type === 'done') assembled = chunk.result;
  }
  if (assembled === undefined) {
    // Not "an empty answer": the transport ended without the frame that carries usage and stop
    // reason, so nothing downstream could tell a complete answer from a cut one.
    throw new AiTransportError({
      provider: 'gateway',
      detail: 'the stream ended without a done chunk, so the answer and its usage are unknown',
    });
  }
  return assembled;
}
