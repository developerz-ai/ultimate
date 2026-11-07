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
import { DATES_HEADER } from './wire-dates';

/** What `clientStream` reads: a write's request, never a raw body or a flight. */
export type StreamRequest = StreamDispatch;

interface Frame {
  readonly event: string;
  readonly data: string;
}

/** Splits a growing buffer into complete frames; the incomplete tail is handed back. */
export function takeFrames(buffer: string): { readonly frames: Frame[]; readonly rest: string } {
  const frames: Frame[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      // A `:` line is a comment — the server's keep-alive.
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) frames.push({ event, data: data.join('\n') });
  }
  return { frames, rest };
}

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
        text: await response.text(),
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
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const taken = takeFrames(done ? `${buffer}\n\n` : buffer);
        buffer = taken.rest;
        for (const frame of taken.frames) {
          if (frame.event === 'chunk') yield JSON.parse(frame.data) as TChunk;
          else if (frame.event === 'done') return JSON.parse(frame.data) as TOutput;
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

function problemStatus(text: string): number {
  try {
    const status = (JSON.parse(text) as { status?: unknown }).status;
    return typeof status === 'number' ? status : 500;
  } catch {
    return 500;
  }
}
