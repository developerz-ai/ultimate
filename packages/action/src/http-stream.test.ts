// The streamed projection over the real pipeline: frames in order, a refusal before the handler is
// the plain problem, a cancelled body aborts `ctx.signal`, a refused chunk is ONE error frame.

import { afterEach, describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import {
  ctxOf,
  InternalError,
  memoryErrorReporter,
  resetErrorReporting,
  runWithContext,
  useContext,
  userActor,
  wireDatePaths,
} from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { InputInvalidError } from './errors';
import { toOpenApiOperation, toRoute } from './http';
import { streamAnswer, wantsEventStream } from './http-stream';

const Chunk = t.object({ text: t.string });
const Out = t.object({ total: t.number });

function serve(
  target: AnyAction,
  actor: Actor | null = userActor({ id: 'u1' }),
  onError?: (error: unknown) => void,
) {
  return httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor, ...(onError === undefined ? {} : { onError }) },
  });
}

const call = (server: ReturnType<typeof serve>, accept: string, signal?: AbortSignal) =>
  server.fetch(
    new Request('http://dev.test/api/words/say', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://dev.test', accept },
      body: JSON.stringify({ n: 2 }),
      ...(signal === undefined ? {} : { signal }),
    }),
  );

const direct = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithContext(ctxOf({ actor: userActor({ id: 'u1' }) }), fn);

const sayWords = () =>
  action({
    input: t.object({ n: t.number }),
    output: Out,
    stream: Chunk,
    policy: allow('words:say'),
    async *handle({ input }) {
      for (let index = 0; index < input.n; index += 1) yield { text: `w${index}` };
      return { total: input.n };
    },
  }).named('sayWords');

describe('a stream-declaring action over HTTP', () => {
  afterEach(() => {
    resetErrorReporting();
  });

  test('accept: text/event-stream answers chunk frames, then one done frame', async () => {
    const response = await call(serve(sayWords()), 'text/event-stream');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toStartWith('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(await response.text()).toBe(
      'event: chunk\ndata: {"text":"w0"}\n\n' +
        'event: chunk\ndata: {"text":"w1"}\n\n' +
        'event: done\ndata: {"total":2}\n\n',
    );
  });

  test('a JSON caller gets the drained output, one contract for every other surface', async () => {
    const target = sayWords();
    const response = await call(serve(target), 'application/json');
    expect(await response.json()).toEqual({ total: 2 });
    expect(await direct(() => target({ n: 3 }))).toEqual({ total: 3 });
  });

  test('a caller the policy refuses gets the plain 403 problem, never a stream', async () => {
    const guarded = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: can('words:say'),
      async *handle() {
        yield { text: 'never' };
        return { total: 0 };
      },
    }).named('sayWords');
    const response = await call(serve(guarded), 'text/event-stream');
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toStartWith('application/problem+json');
  });

  test('a chunk the stream schema refuses is one error frame, then close', async () => {
    const broken = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle() {
        yield { text: 'fine' };
        yield { text: 7 } as unknown as { text: string };
        yield { text: 'never sent' };
        return { total: 1 };
      },
    }).named('sayWords');
    const text = await (await call(serve(broken), 'text/event-stream')).text();
    const frames = text.split('\n\n').filter((frame) => frame !== '');
    expect(frames).toHaveLength(2);
    expect(frames[0]).toBe('event: chunk\ndata: {"text":"fine"}');
    expect(frames[1]).toStartWith('event: error\n');
    expect(frames[1]).toContain('X_ACTION_STREAM_INVALID');
  });

  test('a handler that throws after its first chunk is reported once, like the JSON path', async () => {
    const reporter = memoryErrorReporter();
    installErrorReporter(reporter);
    const fault = () =>
      action({
        input: t.object({ n: t.number }),
        output: Out,
        stream: Chunk,
        policy: allow('words:say'),
        async *handle() {
          yield { text: 'first' };
          throw new InternalError({ cause: 'the store went away', fix: 'bun run x -- doctor' });
        },
      }).named('sayWords');
    const json = await call(serve(fault()), 'application/json');
    expect(json.status).toBe(500);
    expect(reporter.events).toHaveLength(1);
    const viaJson = reporter.events[0];
    reporter.reset();

    const text = await (await call(serve(fault()), 'text/event-stream')).text();
    expect(text).toContain('event: error\n');
    expect(reporter.events).toHaveLength(1);
    const viaStream = reporter.events[0];
    expect(viaStream?.source).toBe('http');
    expect(viaStream?.code).toBe(viaJson?.code);
    expect(viaStream?.scope.operation).toBe(viaJson?.scope.operation);
    expect(viaStream?.scope.requestId).not.toBeUndefined();
  });

  test('a chunk frame carries its own dates line, exactly like the done frame', async () => {
    const dated = action({
      input: t.object({ n: t.number }),
      output: t.object({ at: t.date }),
      stream: t.object({ at: t.date, text: t.string }),
      policy: allow('words:say'),
      async *handle() {
        yield { at: new Date('2026-01-02T03:04:05.000Z'), text: 'w0' };
        return { at: new Date('2026-01-02T03:04:06.000Z') };
      },
    }).named('sayWords');
    const text = await (await call(serve(dated), 'text/event-stream')).text();
    const [chunk, done] = text.split('\n\n');
    const paths = wireDatePaths({ at: new Date(0) });
    expect(paths).not.toBeUndefined();
    expect(chunk).toBe(
      `event: chunk\ndates: ${paths}\ndata: {"at":"2026-01-02T03:04:05.000Z","text":"w0"}`,
    );
    expect(done).toBe(`event: done\ndates: ${paths}\ndata: {"at":"2026-01-02T03:04:06.000Z"}`);
  });

  test("a 5xx after the first chunk reaches the app's onError once, as the JSON path's does", async () => {
    const reporter = memoryErrorReporter();
    installErrorReporter(reporter);
    const seen: unknown[] = [];
    const fault = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle() {
        yield { text: 'first' };
        throw new InternalError({ cause: 'the store went away', fix: 'bun run x -- doctor' });
      },
    }).named('sayWords');
    const server = serve(fault, undefined, (error) => void seen.push(error));
    const text = await (await call(server, 'text/event-stream')).text();
    expect(text).toContain('event: error\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(InternalError);
    expect(reporter.events).toHaveLength(1);
  });

  test('a handler unwinding because the reader cancelled the body is not an incident', async () => {
    const reporter = memoryErrorReporter();
    installErrorReporter(reporter);
    const seen: unknown[] = [];
    const unwound = Promise.withResolvers<void>();
    const slow = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle({ ctx }) {
        yield { text: 'first' };
        try {
          // What `fetch(url, { signal: ctx.signal })` does: reject with the signal's reason.
          await new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
          });
        } finally {
          // One event-loop turn: the stream's settle handler has run by then.
          setImmediate(unwound.resolve);
        }
        return { total: 1 };
      },
    }).named('sayWords');
    const response = await call(
      serve(slow, undefined, (error) => void seen.push(error)),
      'text/event-stream',
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await reader?.cancel();
    await unwound.promise;
    expect(reporter.events).toEqual([]);
    expect(seen).toEqual([]);
  });

  // `reportLateFault` is the ONE report site, and it is the pipeline request's. Every route reaches
  // this stream through the pipeline; one driven with no request behind it is a harness, which
  // reads the error frame it was sent — this file no longer assembles a second monitor scope.
  test('a stream driven outside the pipeline answers the error frame and reports nowhere', async () => {
    const reporter = memoryErrorReporter();
    installErrorReporter(reporter);
    const response = await direct(() =>
      streamAnswer({}, async (sink) => {
        sink.start();
        // The 200 has left by the time this throws: the fault is a late one.
        await new Promise((resolve) => setImmediate(resolve));
        throw new InternalError({ cause: 'the store went away', fix: 'bun run x -- doctor' });
      }),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toStartWith('event: error\n');
    expect(text).toContain('X_INTERNAL');
    expect(reporter.events).toEqual([]);
  });

  test("a 4xx thrown after the first chunk is the caller's and is not reported", async () => {
    const reporter = memoryErrorReporter();
    installErrorReporter(reporter);
    const broken = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle() {
        yield { text: 'first' };
        throw new InputInvalidError('sayWords', 'n ran past the words there are');
      },
    }).named('sayWords');
    const text = await (await call(serve(broken), 'text/event-stream')).text();
    expect(text).toContain('X_INPUT_INVALID');
    expect(reporter.events).toEqual([]);
  });

  test('cancelling the body aborts ctx.signal inside the handler', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const slow = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      async *handle({ ctx }) {
        yield { text: 'first' };
        ctx.signal.addEventListener('abort', () => {
          aborted = useContext().signal.aborted || ctx.signal.aborted;
          release();
        });
        await held;
        return { total: 1 };
      },
    }).named('sayWords');
    const response = await call(serve(slow), 'text/event-stream');
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('"first"');
    await reader?.cancel();
    await held;
    expect(aborted).toBe(true);
  });

  test('stream: beside a handle that is not a generator is X_ACTION_STREAM_INVALID', async () => {
    const wrong = action({
      input: t.object({ n: t.number }),
      output: Out,
      stream: Chunk,
      policy: allow('words:say'),
      handle: (() => ({ total: 1 })) as unknown as () => AsyncGenerator<
        { text: string },
        { total: number },
        undefined
      >,
    }).named('sayWords');
    await expect(direct(() => wrong({ n: 1 }))).rejects.toMatchObject({
      code: 'X_ACTION_STREAM_INVALID',
    });
  });

  test('the OpenAPI 200 documents text/event-stream only for a stream-declaring action', () => {
    const content = (target: AnyAction) =>
      Object.keys(
        (toOpenApiOperation(target).responses['200'] as { content: Record<string, unknown> })
          .content,
      );
    expect(content(sayWords())).toEqual(['application/json', 'text/event-stream']);
    const plain = action({
      input: t.object({ n: t.number }),
      output: Out,
      policy: allow('words:say'),
      handle: ({ input }) => ({ total: input.n }),
    }).named('sayWords');
    expect(content(plain)).toEqual(['application/json']);
  });

  test('accept negotiation reads the media type, not a substring', () => {
    expect(wantsEventStream('text/event-stream')).toBe(true);
    expect(wantsEventStream('application/json, text/event-stream;q=0.9')).toBe(true);
    expect(wantsEventStream('application/json')).toBe(false);
    expect(wantsEventStream('text/event-streamx')).toBe(false);
    expect(wantsEventStream(null)).toBe(false);
  });
});
