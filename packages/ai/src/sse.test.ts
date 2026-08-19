import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { decodeSse, MAX_FRAME_CHARS, readSse, type SseFrame } from './sse';

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of readSse(body, 'test')) frames.push(frame);
  return frames;
}

describe('decodeSse', () => {
  test('returns complete frames and keeps the unterminated tail', () => {
    const decoded = decodeSse('event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3');
    expect(decoded.frames).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
    expect(decoded.rest).toBe('event: c\ndata: 3');
  });

  test('joins repeated data lines with a newline and defaults the event name', () => {
    const decoded = decodeSse('data: one\ndata: two\n\n');
    expect(decoded.frames).toEqual([{ event: 'message', data: 'one\ntwo' }]);
  });

  test('drops heartbeat comments, which carry no data', () => {
    const decoded = decodeSse(': keep-alive\n\ndata: real\n\n');
    expect(decoded.frames).toEqual([{ event: 'message', data: 'real' }]);
  });

  test('accepts CRLF framing and a value with no leading space', () => {
    const decoded = decodeSse('event:ping\r\ndata:{"type":"ping"}\r\n\r\n');
    expect(decoded.frames).toEqual([{ event: 'ping', data: '{"type":"ping"}' }]);
  });

  test('a lone trailing CR is not yet a boundary', () => {
    // Otherwise a frame split between the CR and the LF of its terminator is dispatched twice.
    expect(decodeSse('data: x\r').frames).toEqual([]);
    expect(decodeSse('data: x\r').rest).toBe('data: x\r');
  });
});

describe('readSse', () => {
  test('reassembles a frame split at an arbitrary byte offset', async () => {
    const frames = await collect(streamOf(['event: mes', 'sage_st', 'art\ndata: {"a":1}\n\n']));
    expect(frames).toEqual([{ event: 'message_start', data: '{"a":1}' }]);
  });

  test('decodes a multi-byte character split across two chunks', async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode('data: ✅\n\n');
    const frames = await collect(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 8));
          controller.enqueue(bytes.slice(8));
          controller.close();
        },
      }),
    );
    expect(frames).toEqual([{ event: 'message', data: '✅' }]);
  });

  test('flushes a final frame that arrived without its terminating blank line', async () => {
    // A truncated stream must reach the consumer, which is the only layer that can tell a
    // complete answer from a cut one — dropping the tail here would hide the cut.
    const frames = await collect(streamOf(['data: a\n\ndata: b\n']));
    expect(frames).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ]);
  });

  test('cancels the body when the consumer stops reading early', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    // Deliberately left open, like a live connection: a closed stream has nothing to cancel.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\n\ndata: b\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of readSse(body, 'test')) {
      expect(frame.data).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });

  test('refuses a peer that never completes a frame instead of buffering it forever', async () => {
    // No boundary is ever sent, so every read succeeds and nothing else in the pipeline can ever
    // interrupt the growth — a read deadline included.
    const encoder = new TextEncoder();
    const filler = 'x'.repeat(64 * 1024);
    let sent = 0;
    // Finite, at twice the cap: an endless fixture would HANG rather than fail when the guard is
    // removed, and a test whose failure mode is a hung CI job is a test nobody reads.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_FRAME_CHARS * 2) {
          controller.close();
          return;
        }
        sent += filler.length;
        controller.enqueue(encoder.encode(filler));
      },
    });

    const read = async (): Promise<void> => {
      for await (const _frame of readSse(body, 'openai')) {
        throw new Error('a frame was yielded from a body that carries no frame boundary');
      }
    };

    const error: unknown = await read().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isUltimateError(error)).toBe(true);
    if (!isUltimateError(error)) return;
    expect(error.code).toBe('X_AI_PROVIDER_UNAVAILABLE');
    expect(error.cause).toContain('openai');
    // Bounded, and bounded by the cap rather than by the fixture running out of bytes.
    expect(sent).toBeLessThanOrEqual(MAX_FRAME_CHARS + filler.length);
  });
});
