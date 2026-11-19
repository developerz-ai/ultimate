/**
 * The HTTP projection's streamed answer: a stream-declaring action asked for with
 * `accept: text/event-stream` answers `event: chunk` per yielded chunk, then ONE `event: done`
 * (the output) or `event: error` (the problem document), then closes. A refusal decided before the
 * handler starts — the policy, the input, the rate limit — is the ordinary problem response.
 */

import type { Ctx } from '@ultimat3/core';
import { useContext, withChildContext } from '@ultimat3/core';
import { cappedWireDates, reportLateFault, toProblem } from '@ultimat3/http';
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

/**
 * One SSE frame. JSON never holds a raw newline, so `data:` is always one line. `dates` is the
 * `x-ultimate-dates` value for THIS frame's data (core's `wire-dates.ts`, URI-encoded, so one line
 * too): a field the SSE format tells every reader that does not know it to ignore, so a client from
 * before it reads the frame it always read. Under the header's cap (`cappedWireDates`): a frame
 * whose value is past it carries no `dates:` line, and its instants are read as ISO strings.
 */
export function sseFrame(
  event: 'chunk' | 'done' | 'error',
  data: unknown,
  dates?: string,
): Uint8Array {
  const named = dates === undefined ? '' : `dates: ${dates}\n`;
  return encoder.encode(`event: ${event}\n${named}data: ${JSON.stringify(data ?? null)}\n\n`);
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
  // Read here, in the request's frame: the settle below runs on a later turn.
  const ctx = useContext();
  const requestId = ctx.requestId;
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
    push: (chunk) => send(sseFrame('chunk', chunk, cappedWireDates(chunk, ctx))),
  };
  // The handler's own scope: its signal is the request's and `left`'s, composed.
  let scope: Ctx = ctx;
  const settled = withChildContext({ signal: left.signal }, () => {
    scope = useContext();
    return run(sink);
  });
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
        (output) => finish(sseFrame('done', output, cappedWireDates(output, ctx))),
        (error: unknown) => {
          // A fault after the first byte never reaches the pipeline's `error-map` stage — the 200
          // has gone — so the request's late-fault report records it (the monitor, the app's
          // `onError`, the log line, once). It tells the reader cancelling, or the caller hanging
          // up, from a failure by `scope`'s signal, and records nothing for those.
          reportLateFault(error, scope);
          finish(sseFrame('error', toProblem(error, { requestId })));
        },
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
