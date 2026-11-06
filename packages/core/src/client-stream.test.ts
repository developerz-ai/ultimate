// `clientStream`: chunks reach the reader BEFORE the stream ends (a held body proves it is not
// buffered), `done` is the return value, an `error` frame and a non-2xx are coded problems, and
// the request is `client-dispatch.ts`'s: its signal, headers, session fence and network code.

import { afterEach, describe, expect, test } from 'bun:test';
import { IDEMPOTENCY_HEADER } from './client-dispatch';
import { rescope } from './client-scope';
import { clientStream, takeFrames } from './client-stream';
import { failure, fakeFetch, heldFetch } from './client-transport-fixture';
import { isUltimateError } from './errors';
import { sessionIsLost } from './session-lost';

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
});

const encoder = new TextEncoder();

/** A response whose body the test feeds by hand, so "arrived before the end" is observable. */
function held() {
  let push: (text: string) => void = () => undefined;
  let end: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(encoder.encode(text));
      end = () => controller.close();
    },
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  return { response, push: (text: string) => push(text), end: () => end() };
}

describe('clientStream', () => {
  test('a chunk is yielded while the body is still open, done is the return', async () => {
    const wire = held();
    let sent: RequestInit | undefined;
    const stream = clientStream<{ text: string }, { total: number }>({
      url: '/api/words/say',
      body: { n: 2 },
      fetchImpl: (_url, init) => {
        sent = init;
        return Promise.resolve(wire.response);
      },
    });
    const first = stream.next();
    wire.push('event: chunk\ndata: {"text":"w0"}\n\n');
    expect(await first).toEqual({ done: false, value: { text: 'w0' } });
    expect(new Headers(sent?.headers).get('accept')).toBe('text/event-stream');
    expect(sent?.credentials).toBe('same-origin');
    const second = stream.next();
    wire.push(': keep-alive\n\nevent: done\ndata: {"total":1}\n\n');
    expect(await second).toEqual({ done: true, value: { total: 1 } });
    // The body was released at `done`: the server hears the reader leave.
    expect(() => wire.end()).toThrow();
  });

  test('an error frame is thrown as the coded problem it carries', async () => {
    const wire = held();
    const stream = clientStream({ url: '/x', fetchImpl: () => Promise.resolve(wire.response) });
    wire.push(
      'event: error\ndata: {"status":500,"code":"X_ACTION_STREAM_INVALID","title":"t","detail":"d"}\n\n',
    );
    wire.end();
    await expect(stream.next()).rejects.toMatchObject({ code: 'X_ACTION_STREAM_INVALID' });
  });

  test('a refusal before the stream is the problem decode, as every other client call', async () => {
    const stream = clientStream({
      url: '/x',
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"status":403,"code":"X_POLICY_DENIED","title":"denied"}', {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          }),
        ),
    });
    await expect(stream.next()).rejects.toMatchObject({ code: 'X_POLICY_DENIED' });
  });

  test("the caller's signal bounds the request: an abort ends it before any answer", async () => {
    const held = heldFetch();
    const controller = new AbortController();
    const pending = failure(
      clientStream({ url: '/x', signal: controller.signal, fetchImpl: held.fetchImpl }).next(),
    );
    controller.abort();
    expect(held.aborted()).toBe(true);
    expect(await pending).toBeInstanceOf(DOMException);
  });

  test("the key, the caller's headers and a JSON body ride the dispatch's init", async () => {
    const wire = fakeFetch(() => new Response('{"ok":1}'));
    const stream = clientStream({
      url: '/x',
      body: { n: 1 },
      idempotencyKey: 'k-1',
      headers: { 'x-extra': 'y' },
      fetchImpl: wire.fetchImpl,
    });
    // A server that answered JSON gave the whole answer: the output, no chunks.
    expect(await stream.next()).toEqual({ done: true, value: { ok: 1 } });
    const headers = new Headers(wire.calls[0]?.init.headers);
    expect(wire.calls[0]?.init.method).toBe('POST');
    expect(headers.get(IDEMPOTENCY_HEADER)).toBe('k-1');
    expect(headers.get('x-extra')).toBe('y');
    expect(headers.get('content-type')).toBe('application/json');
    expect(wire.calls[0]?.init.body).toBe('{"n":1}');
  });

  test("a 401 refusal is the page's session loss, as every other client call's", async () => {
    rescope('user:1');
    const stream = clientStream({
      url: '/x',
      fetchImpl: () =>
        Promise.resolve(
          new Response('{"status":401,"code":"X_UNAUTHENTICATED","title":"t"}', { status: 401 }),
        ),
    });
    await expect(stream.next()).rejects.toMatchObject({ code: 'X_UNAUTHENTICATED' });
    expect(sessionIsLost()).toBe(true);
  });

  test('a network failure is coded, and never retryable — even keyed', async () => {
    const error = await failure(
      clientStream({
        url: '/x',
        idempotencyKey: 'k-1',
        fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')),
      }).next(),
    );
    expect(isUltimateError(error) && error.code).toBe('X_CLIENT_TRANSPORT_FAILED');
    expect(isUltimateError(error) && error.retry).not.toBe('retryable');
  });

  test('frames split across reads are joined; the tail waits for its blank line', () => {
    const first = takeFrames('event: chunk\ndata: {"a":1}\n\nevent: chu');
    expect(first.frames).toEqual([{ event: 'chunk', data: '{"a":1}' }]);
    expect(first.rest).toBe('event: chu');
  });
});
