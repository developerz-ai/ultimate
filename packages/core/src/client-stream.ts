/**
 * The browser's streamed read of a stream-declaring action: `POST`, `accept: text/event-stream`,
 * through `client-dispatch.ts`'s `dispatchStream`, never `EventSource` (cannot POST). Each `chunk`
 * frame yields as it arrives, `done` is the return, `error` throws the problem it carries.
 */

import type { StreamDispatch } from './client-dispatch';
import { dispatchStream } from './client-dispatch';
import { problemError, transportFailed } from './client-problem';
import { settleAnswer } from './client-transport';
import { notifyClientWrite } from './client-writes';
import { RECORDS_HEADER } from './record-envelope';
import { pageClient } from './record-sink';
import { takeFrames } from './sse-frames';
import { DATES_HEADER, reviveWireDates } from './wire-dates';

/** What `clientStream` reads: a write's request, never a raw body or a flight. */
export type StreamRequest = StreamDispatch;

export async function* clientStream<TChunk = unknown, TOutput = unknown>(
  req: StreamRequest,
): AsyncGenerator<TChunk, TOutput, undefined> {
  const issued = pageClient().scope.epoch;
  try {
    const response = await dispatchStream(req);
    // A server that answered JSON (no stream declared, or a proxy) gave the whole answer at once —
    // `call()`'s answer, so it is settled exactly as `call()` settles it.
    if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const answer = {
        text: await midBody(req.url, () => response.text()),
        enveloped: response.headers.get(RECORDS_HEADER) === '1',
        dates: response.headers.get(DATES_HEADER),
      };
      return settleAnswer(answer, req, false, issued) as TOutput;
    }
    const reader = response.body?.getReader();
    if (reader === undefined)
      throw transportFailed('body', `${req.url} answered a stream with no body`, undefined, {
        url: req.url,
      });
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await midBody(req.url, () => reader.read());
        buffer += decoder.decode(value, { stream: !done });
        const taken = takeFrames(done ? `${buffer}\n\n` : buffer);
        buffer = taken.rest;
        for (const frame of taken.frames) {
          // Both frames name their instants on a `dates:` line, so a chunk is revived as `done` is.
          const parsed = (): Promise<unknown> =>
            midBody(req.url, () => reviveWireDates(JSON.parse(frame.data), frame.dates ?? null));
          if (frame.event === 'chunk') yield (await parsed()) as TChunk;
          else if (frame.event === 'done') return (await parsed()) as TOutput;
          else if (frame.event === 'error') {
            const status = problemStatus(frame.data);
            throw (
              req.decodeError?.(status, frame.data) ?? problemError(status, frame.data, req.url)
            );
          }
        }
        if (done) break;
      }
    } finally {
      // A consumer that stopped early releases the body: the server sees the disconnect and aborts.
      await reader.cancel().catch(() => undefined);
    }
    throw transportFailed(
      'body',
      `${req.url} closed its stream before a done or error frame`,
      undefined,
      { url: req.url },
    );
  } finally {
    notifyClientWrite(req.url);
  }
}

/**
 * A body the network cut (`TypeError`: `failure: 'network'`) or a frame that is not JSON
 * (`SyntaxError`: `'body'`), coded and terminal — a write may already have landed. Anything else,
 * an abort included, passes through: the same reading as `dispatch`'s.
 */
async function midBody<T>(url: string, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const network = error instanceof TypeError;
    if (!network && !(error instanceof SyntaxError)) throw error;
    const failure = network ? 'network' : 'body';
    throw transportFailed(
      failure,
      `${url}'s stream broke mid-body (${failure})`,
      undefined,
      { url },
      error,
    );
  }
}

function problemStatus(text: string): number {
  try {
    const status = (JSON.parse(text) as { status?: unknown }).status;
    return typeof status === 'number' ? status : 500;
  } catch {
    return 500;
  }
}
