// At `X_TIMEOUT` the socket is answered and the handler is not finished: it still holds its pool
// slot and whatever it was writing. The in-flight count dropped when the RESPONSE left, so a drain
// saw an idle process and closed the pool under work that was still running.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { inflightCount, resetLifecycle } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { text } from './response';
import { createRouter, type RouteHandler } from './router';

const pipelineFor = (handler: RouteHandler, requestTimeoutMs = 20) =>
  createPipeline({
    table: createRouter([
      { method: 'GET', path: '/slow', meta: { name: 'slow', auth: 'public' }, handler },
    ]),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      requestTimeoutMs,
    }),
  });

const call = (pipeline: ReturnType<typeof createPipeline>): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/slow'), { role: 'web' });

const gate = (): { readonly held: Promise<void>; open(): void; fail(): void } => {
  let open = (): void => undefined;
  let fail = (): void => undefined;
  const held = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new TypeError('the handler failed after its deadline'));
  });
  return { held, open: () => open(), fail: () => fail() };
};

beforeEach(() => resetLifecycle());
afterEach(() => resetLifecycle());

describe('a handler that outlives its deadline is still in flight', () => {
  test('it is counted from the 504 until it settles, then released', async () => {
    const work = gate();
    const pipeline = pipelineFor(async () => {
      await work.held;
      return text('late');
    });
    const response = await call(pipeline);
    expect(response.status).toBe(504);
    expect(inflightCount()).toBe(1);
    work.open();
    await Bun.sleep(0);
    expect(inflightCount()).toBe(0);
  });

  test('a late rejection releases it too, and never escapes as an unhandled one', async () => {
    const work = gate();
    const pipeline = pipelineFor(async () => {
      await work.held;
      return text('never');
    });
    expect((await call(pipeline)).status).toBe(504);
    expect(inflightCount()).toBe(1);
    work.fail();
    await Bun.sleep(0);
    expect(inflightCount()).toBe(0);
  });

  test('a handler that finished in time, or threw in time, holds nothing afterwards', async () => {
    expect((await call(pipelineFor(() => text('ok'), 1_000))).status).toBe(200);
    expect(inflightCount()).toBe(0);
    const thrown = await call(
      pipelineFor(() => {
        throw new TypeError('in time');
      }, 1_000),
    );
    expect(thrown.status).toBe(500);
    expect(inflightCount()).toBe(0);
  });
});
