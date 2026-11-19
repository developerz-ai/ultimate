// The deadline's answer is final: the race winner alone writes the response slot, a caller that
// hung up is a 499 and not an incident, and a streamed body is outside the budget by declaration.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { memoryErrorReporter, resetErrorReporting, resetLifecycle } from '@ultimat3/core';
import { installErrorReporter } from '@ultimat3/core/adapter';
import { defineHttpConfig } from './config';
import type { ServerHooks } from './hooks';
import { httpPipeline } from './pipeline';
import { resetRefusalLog } from './refusal-log';
import { jsonResponse, stream } from './response';
import { httpRouter, type RouteHandler } from './router';

const TIMEOUT_MS = 20;
const REMOTE = '203.0.113.9';

const pipelineFor = (
  handler: RouteHandler,
  hooks: ServerHooks = {},
  requestTimeoutMs = TIMEOUT_MS,
) =>
  httpPipeline({
    table: httpRouter([
      { method: 'GET', path: '/slow', meta: { name: 'slow', auth: 'public' }, handler },
    ]),
    hooks,
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      requestTimeoutMs,
    }),
  });

const aborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const reporter = memoryErrorReporter();

beforeEach(() => {
  resetLifecycle();
  resetRefusalLog();
  resetErrorReporting();
  reporter.reset();
  installErrorReporter(reporter);
});

afterEach(() => {
  resetErrorReporting();
  resetLifecycle();
});

describe('the request deadline', () => {
  test('a handler that answers a fallback after the abort never replaces the 504, at any microtask distance', async () => {
    for (let hops = 0; hops <= 10; hops += 1) {
      const pipeline = pipelineFor(async (_request, ctx) => {
        try {
          return await aborted(ctx.signal);
        } catch {
          for (let hop = 0; hop < hops; hop += 1) await null;
          return jsonResponse({ fallback: true });
        }
      });

      const response = await pipeline.handle(new Request('http://app.test/slow'), {
        role: 'web',
        ip: REMOTE,
      });

      expect({ hops, status: response.status }).toEqual({ hops, status: 504 });
      expect(response.headers.get('x-request-id')).not.toBeNull();
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(((await response.json()) as { code: string }).code).toBe('X_TIMEOUT');
    }
  });

  test('an orphan that answers a stream after the 504 has its body cancelled', async () => {
    const cancelled = Promise.withResolvers<void>();
    const pipeline = pipelineFor(async (_request, ctx) => {
      await aborted(ctx.signal).catch(() => undefined);
      // A macrotask later: the 504 has left by the time this answer exists.
      await new Promise((turn) => setImmediate(turn));
      return stream(new ReadableStream({ cancel: () => cancelled.resolve() }), {
        contentType: 'text/plain',
      });
    });

    const response = await pipeline.handle(new Request('http://app.test/slow'), {
      role: 'web',
      ip: REMOTE,
    });

    expect(response.status).toBe(504);
    await cancelled.promise;
  });

  test('a caller that goes away mid-handler is a 499, never reported', async () => {
    const seen: unknown[] = [];
    const entered = Promise.withResolvers<void>();
    const lines: { level: string; msg: string }[] = [];
    const pipeline = pipelineFor(
      async (_request, ctx) => {
        for (const level of ['info', 'warn', 'error'] as const) {
          const emit = ctx.logger[level].bind(ctx.logger);
          ctx.logger[level] = (msg, fields) => {
            lines.push({ level, msg });
            emit(msg, fields);
          };
        }
        entered.resolve();
        return await aborted(ctx.signal);
      },
      { onError: (error) => void seen.push(error) },
      0,
    );
    const caller = new AbortController();

    const pending = pipeline.handle(
      new Request('http://app.test/slow', { signal: caller.signal }),
      { role: 'web', ip: REMOTE },
    );
    await entered.promise;
    // What Bun puts on `Request.signal.reason` when the socket closes: uncoded, numeric `code`.
    caller.abort(new DOMException('The connection was closed.', 'AbortError'));
    const response = await pending;

    expect(response.status).toBe(499);
    expect(((await response.json()) as { code: string }).code).toBe('X_ABORTED');
    expect(reporter.events).toEqual([]);
    expect(seen).toHaveLength(1);
    expect(lines).toEqual([{ level: 'info', msg: 'X_ABORTED' }]);
  });

  test('a handler fault that is not the hang-up is still a reported 500 after the caller left', async () => {
    const entered = Promise.withResolvers<void>();
    const pipeline = pipelineFor(
      async (_request, ctx) => {
        entered.resolve();
        await aborted(ctx.signal).catch(() => undefined);
        // A defect of the handler's own, after the hang-up: input to the pipeline, not a verdict.
        return Promise.reject(new TypeError('unrelated defect'));
      },
      {},
      0,
    );
    const caller = new AbortController();

    const pending = pipeline.handle(
      new Request('http://app.test/slow', { signal: caller.signal }),
      { role: 'web', ip: REMOTE },
    );
    await entered.promise;
    caller.abort(new DOMException('The connection was closed.', 'AbortError'));
    const response = await pending;

    expect(response.status).toBe(500);
    expect(reporter.events).toHaveLength(1);
  });

  test('a streamed body past the deadline: the budget covered time-to-headers, ctx.signal stays unfired', async () => {
    let signal: AbortSignal | undefined;
    const pipeline = pipelineFor((_request, ctx) => {
      signal = ctx.signal;
      return stream(new ReadableStream({ start: (out) => out.enqueue(new Uint8Array([120])) }), {
        contentType: 'text/event-stream',
      });
    });

    jest.useFakeTimers();
    try {
      const response = await pipeline.handle(new Request('http://app.test/slow'), {
        role: 'web',
        ip: REMOTE,
      });
      jest.advanceTimersByTime(TIMEOUT_MS * 3);

      expect(response.status).toBe(200);
      expect(signal?.aborted).toBe(false);
      await response.body?.cancel();
    } finally {
      jest.useRealTimers();
    }
  });
});
