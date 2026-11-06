/**
 * The HTTP projection's streamed answer: a stream-declaring action asked for with
 * `accept: text/event-stream` answers `event: chunk` per yielded chunk, then ONE `event: done`
 * (the output) or `event: error` (the problem document), then closes. A refusal decided before the
 * handler starts — the policy, the input, the rate limit — is the ordinary problem response.
 */

import { useContext, withChildContext } from '@ultimat3/core';
import { toProblem } from '@ultimat3/http';
import type { ChunkSink } from './action-stream';

export const EVENT_STREAM = 'text/event-stream';

/** A comment line every interval, so an idle proxy does not close a long answer. */
export const HEARTBEAT_MS = 15_000;

/** True for a request that lists `text/event-stream` in its `accept`. */
export function wantsEventStream(accept: string | null): boolean {
  if (accept === null) return false;
  return accept
    .split(',')
    .some((part) => part.split(';')[0]?.trim().toLowerCase() === EVENT_STREAM);
}

const encoder = new TextEncoder();
const STARTED: unique symbol = Symbol('started');

/** One SSE frame. JSON never holds a raw newline, so `data:` is always one line. */
export function sseFrame(event: 'chunk' | 'done' | 'error', data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data ?? null)}\n\n`);
}

/** Runs the invocation with `sink` receiving its chunks; resolves the output. */
export type StreamRun = (sink: ChunkSink) => Promise<unknown>;

/**
 * Starts `run` and answers once the handler has started (the stream) or the invocation settled
 * first (a refusal is THROWN, so the route's error path answers it; a replay is a lone `done`).
 */
export async function streamAnswer(
  owner: object,
  run: StreamRun,
  heartbeatMs: number = HEARTBEAT_MS,
): Promise<Response> {
  const requestId = useContext().requestId;
  // The client leaving cancels the body; that aborts this signal, added to the request's own.
  const left = new AbortController();
  let out: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const send = (bytes: Uint8Array): void => {
    if (!closed) out?.enqueue(bytes);
  };
  let begin: () => void = () => undefined;
  const started = new Promise<typeof STARTED>((resolve) => {
    begin = () => resolve(STARTED);
  });
  const sink: ChunkSink = {
    owner,
    start: () => begin(),
    push: (chunk) => send(sseFrame('chunk', chunk)),
  };
  const settled = withChildContext({ signal: left.signal }, () => run(sink));
  // Settled without starting is a refusal — thrown here, before any byte — or a replayed answer,
  // which streams as a lone `done`.
  await Promise.race([started, settled]);
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      timer = setInterval(() => send(encoder.encode(': keep-alive\n\n')), heartbeatMs);
      const finish = (bytes: Uint8Array): void => {
        clearInterval(timer);
        send(bytes);
        if (!closed) {
          closed = true;
          controller.close();
        }
      };
      settled.then(
        (output) => finish(sseFrame('done', output)),
        (error: unknown) => finish(sseFrame('error', toProblem(error, { requestId }))),
      );
    },
    cancel() {
      closed = true;
      clearInterval(timer);
      left.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': `${EVENT_STREAM}; charset=utf-8`,
      'cache-control': 'no-store',
      // nginx and its kin buffer a response unless told not to; a buffered stream is a JSON answer.
      'x-accel-buffering': 'no',
    },
  });
}
