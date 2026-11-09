// A declared `webhookReceiver()` is mounted by the boot with no `runtime.ts` entry, answers through
// the real pipeline, and is listed once even when an app still names its routes by hand.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpPipeline, httpRouter } from '@ultimat3/http';
import { memoryJobDriver, resetJobs, webhookReceiver } from '@ultimat3/jobs';
import { installJobDriver, resetJobDriver } from '@ultimat3/jobs/adapter';
import { plainRoutes } from './plain-routes';
import { plainAppRoutes } from './route-table';

afterEach(() => {
  resetJobs();
  resetJobDriver();
});

const declare = () =>
  webhookReceiver({
    name: 'plain-routes.vendor',
    path: '/hooks/vendor',
    tenant: 'none',
    verify: () => ({ eventId: 'evt_1', payload: null }),
    handle: () => Promise.resolve(),
  });

describe('plainRoutes', () => {
  test('a declared receiver answers with no runtime.ts entry', async () => {
    declare();
    installJobDriver(memoryJobDriver());
    const pipeline = httpPipeline({
      table: httpRouter(plainRoutes(undefined)),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false }),
    });
    const response = await pipeline.handle(
      new Request('http://localhost/hooks/vendor', { method: 'POST', body: '{}' }),
      { role: 'web' },
    );
    expect(await response.json()).toEqual({ ok: true, eventId: 'evt_1', deduped: false });
  });

  test('the runtime.ts routes come first, and a receiver named there too is mounted once', () => {
    const receiver = declare();
    const [first] = receiver.routes();
    if (first === undefined) return expect.unreachable('the receiver declares no route');
    const own = {
      ...first,
      path: '/feed.xml',
      meta: { name: 'feed', auth: 'public' },
    } as const;
    expect(plainRoutes([own, ...receiver.routes()])).toEqual([own, ...receiver.routes()]);
  });

  test('x routes lists a declared receiver for an app with no runtime.ts', async () => {
    declare();
    const root = `${import.meta.dir}/../.no-such-app-${process.pid}`;
    expect((await plainAppRoutes(root)).map((route) => route.meta.name)).toEqual([
      'webhook.plain-routes.vendor',
    ]);
  });
});
