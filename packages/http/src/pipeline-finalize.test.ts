// What `handle()`'s "always resolves to a Response" contract is worth once the request is already
// answered: the two stages that run after the handler, and the one that renders a throw, may not
// reject it. Split out of `pipeline.test.ts`, which pins the order and is at its ceiling.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ErrorReport } from '@ultimat3/core';
import {
  collectMetrics,
  configureErrorReporting,
  memoryErrorReporter,
  resetErrorReporting,
  resetMetrics,
} from '@ultimat3/core';
import { defineHttpConfig } from './config';
import type { RequestContext } from './context';
import { problemTypeFor } from './error-map';
import { recoverWith } from './finalize';
import type { ServerHooks } from './hooks';
import { createPipeline } from './pipeline';
import type { UltimateRequest } from './request';
import { text } from './response';
import { createRouter, type Route } from './router';

/**
 * A response the finalize stages cannot finish. Per spec a `Response.redirect()` carries immutable
 * headers and throws on the merge — Bun does not enforce that guard today, so the same refusal is
 * staged here, on a real Response, rather than pinning the test to one runtime's leniency.
 *
 * `allowedReads` is how many header reads succeed first: 0 refuses in `cache-headers`, the first
 * finalize stage; 1 lets a response that already carries `cache-control` through it and refuses in
 * `response`, the LAST one — the case where nothing downstream is left to repair the answer.
 */
const refusesHeaders = (response: Response, allowedReads: number): Response => {
  const real = response.headers;
  let reads = 0;
  Object.defineProperty(response, 'headers', {
    get: (): Headers => {
      reads += 1;
      if (reads > allowedReads) throw new TypeError('immutable headers');
      return real;
    },
  });
  return response;
};

/**
 * Two throwables that fight being READ, in two different places. A null-prototype object carries
 * no `Symbol.toPrimitive` and no `toString`, so `String(it)` is itself a `TypeError`; a `Proxy`
 * throws out of `getPrototypeOf` (which `instanceof` calls) and out of `get` (which any property
 * read calls). An ordinary `Error` proves nothing about this tail — every guard here survives one
 * already.
 */
const nullPrototype = (): unknown => Object.create(null) as unknown;

const unreadable = (): unknown =>
  new Proxy(
    {},
    {
      getPrototypeOf: (): never => {
        throw new TypeError('the prototype is not for you');
      },
      get: (): never => {
        throw new TypeError('the properties are not for you');
      },
    },
  );

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/unfinishable',
    meta: { name: 'unfinishable', auth: 'public' },
    handler: () => refusesHeaders(text('ok'), 0),
  },
  {
    method: 'GET',
    path: '/unfinishable-last',
    meta: { name: 'unfinishable.last', auth: 'public' },
    // `cache-control` is already set, so `cache-headers` reads the headers once and returns; the
    // refusal lands on `response`, after which no stage remains to put anything on the answer.
    handler: () => refusesHeaders(text('ok', { headers: { 'cache-control': 'no-store' } }), 1),
  },
  {
    method: 'GET',
    path: '/never-finishable',
    meta: { name: 'never-finishable', auth: 'public' },
    // The refusal is on the CONTEXT's accumulated headers, not on the response, so replacing the
    // response cannot clear it: the `response` stage refuses the degraded answer as well.
    handler: (_request, ctx) => {
      Object.defineProperty(ctx, 'headers', {
        get: (): Headers => {
          throw new TypeError('immutable headers');
        },
      });
      return text('ok');
    },
  },
  {
    method: 'GET',
    path: '/ok',
    meta: { name: 'ok', auth: 'public' },
    handler: () => text('ok'),
  },
  {
    method: 'GET',
    path: '/hostile',
    meta: { name: 'hostile', auth: 'public' },
    // Not an `Error`: the recover stage has to RENDER whatever a handler threw, and a value that
    // refuses every property read is the one it cannot ask `factsOf` about twice.
    handler: () => {
      throw unreadable();
    },
  },
  {
    method: 'GET',
    path: '/boom',
    meta: { name: 'boom', auth: 'public' },
    handler: () => {
      throw new TypeError('undefined is not a function');
    },
  },
];

const config = defineHttpConfig({
  rateLimit: { scope: 'process' },
  dev: false,
  buildId: null,
  hostname: '127.0.0.1',
});
const pipelineWith = (hooks: ServerHooks = {}) =>
  createPipeline({ table: createRouter(routes), config, hooks });
const get = (path: string) => new Request(`http://localhost${path}`);
const bodyOf = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('a finalize stage that throws', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
    resetMetrics();
  });

  afterEach(() => {
    resetErrorReporting();
  });

  // Before: the finalize loop ran unguarded after the try/catch, so this rejected `handle()` —
  // against the contract on `Pipeline.handle` — and the caller got whatever the runtime prints.
  test('answers the coded 500 instead of rejecting', async () => {
    const response = await pipelineWith().handle(get('/unfinishable'), { role: 'web' });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await bodyOf(response);
    expect(body['code']).toBe('X_PIPELINE_FINALIZE_FAILED');
    expect(body['cause']).toContain('cache-headers');
    expect(body['cause']).toContain('immutable headers');
    expect(body['fix']).toContain('redirect()');
  });

  test('the degraded answer still carries the request id and the security headers', async () => {
    const response = await pipelineWith().handle(get('/unfinishable'), { role: 'web' });

    const requestId = response.headers.get('x-request-id');
    expect(requestId).not.toBeNull();
    expect((await bodyOf(response))['requestId']).toBe(requestId as string);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('server-timing')).toContain('total;dur=');
  });

  // The second pass is the whole point: the stage that refused the handler's response gets to run
  // again on the problem document, whose headers ARE writable.
  test('a refusal in the LAST stage is repaired too, not answered bare', async () => {
    const response = await pipelineWith().handle(get('/unfinishable-last'), { role: 'web' });

    expect(response.status).toBe(500);
    expect((await bodyOf(response))['code']).toBe('X_PIPELINE_FINALIZE_FAILED');
    expect(response.headers.get('x-request-id')).not.toBeNull();
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  // Through the recover stage, which is this package's one reporting call site — not around it.
  test('the error monitor is paged once, and the app’s onError hook sees it too', async () => {
    const seen: string[] = [];
    const response = await pipelineWith({
      onError: (error) => seen.push((error as { code?: string }).code ?? 'no-code'),
    }).handle(get('/unfinishable'), { role: 'web' });

    expect(seen).toEqual(['X_PIPELINE_FINALIZE_FAILED']);
    expect(reporter.events).toHaveLength(1);
    const event = reporter.events[0] as ErrorReport;
    expect(event.code).toBe('X_PIPELINE_FINALIZE_FAILED');
    expect(event.source).toBe('http');
    expect(event.scope.requestId).toBe(response.headers.get('x-request-id') as string);
  });

  test('the request is still counted, at the status the caller got', async () => {
    await pipelineWith().handle(get('/unfinishable'), { role: 'web' });

    const total = (collectMetrics().metrics.find(
      (metric) => metric.descriptor.name === 'http_requests_total',
    )?.points ?? []) as readonly { attributes: Record<string, unknown>; value: number }[];
    expect(
      total
        .filter((point) => point.attributes['route'] === '/unfinishable')
        .map((point) => [point.attributes['status'], point.value]),
    ).toEqual([['5xx', 1]]);
  });

  // The bound, stated: a response nothing can finish is answered, not retried forever. Two passes
  // means at most two renderings — a third would be the same outage with more log lines.
  test('a refusal the degraded answer cannot escape stops at the 500', async () => {
    const response = await pipelineWith().handle(get('/never-finishable'), { role: 'web' });

    expect(response.status).toBe(500);
    expect((await bodyOf(response))['code']).toBe('X_PIPELINE_FINALIZE_FAILED');
    expect(reporter.events).toHaveLength(2);
  });

  test('a response the stages CAN finish is untouched', async () => {
    const response = await pipelineWith().handle(get('/ok'), { role: 'web' });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(response.headers.get('cache-control')).toContain('max-age');
    expect(reporter.events).toEqual([]);
  });
});

describe('a recover stage that throws', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetErrorReporting();
  });

  // The stage that turns a throw into a status is the last thing that could render its own, so a
  // hook that throws inside it used to reject `handle()` from the one place with no fallback.
  test('an onError hook that throws still answers the error the request hit', async () => {
    const response = await pipelineWith({
      onError: () => {
        throw new Error('the sink is down');
      },
    }).handle(get('/boom'), { role: 'web' });

    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body['code']).toBe('X_INTERNAL');
    expect(body['cause']).toContain('undefined is not a function');
    // The framework's report goes out before the app's hook, so the monitor still holds it.
    expect(reporter.events).toHaveLength(1);
  });

  test('a hook that throws on a request that also cannot be finished still answers', async () => {
    const response = await pipelineWith({
      onError: () => {
        throw new Error('the sink is down');
      },
    }).handle(get('/unfinishable'), { role: 'web' });

    expect(response.status).toBe(500);
    expect((await bodyOf(response))['code']).toBe('X_PIPELINE_FINALIZE_FAILED');
  });

  test('a devNotices producer that throws does not take the overlay down', async () => {
    const dev = defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: true,
      buildId: null,
      hostname: '127.0.0.1',
    });
    const pipeline = createPipeline({
      table: createRouter(routes),
      config: dev,
      hooks: {
        devNotices: () => {
          throw new Error('the detector is broken');
        },
      },
    });

    const response = await pipeline.handle(
      new Request('http://localhost/boom', { headers: { accept: 'text/html' } }),
      { role: 'web' },
    );

    expect(response.status).toBe(500);
    expect((await bodyOf(response))['code']).toBe('X_INTERNAL');
  });
});

/**
 * The class of defect, not one instance of it: a documented total contract reached past an
 * unguarded `String(x)`, `${x}` or `instanceof` on a value the framework did not build. Both
 * guards in this tail are total or `handle()` has no answer at all.
 */
describe('a throwable that fights being read', () => {
  const reporter = memoryErrorReporter();

  beforeEach(() => {
    resetErrorReporting();
    reporter.reset();
    configureErrorReporting({ reporter });
  });

  afterEach(() => {
    resetErrorReporting();
  });

  // Before: `recoverWith`'s catch built its log line with `String(failure)`, so an `onError` sink
  // throwing a null-prototype object threw a second `TypeError` out of the guard documented
  // "never throws, by construction" — and `handle()` rejected.
  test('an onError hook throwing a null-prototype object still answers', async () => {
    const response = await pipelineWith({
      onError: () => {
        throw nullPrototype();
      },
    }).handle(get('/boom'), { role: 'web' });

    expect(response.status).toBe(500);
    const body = await bodyOf(response);
    expect(body['code']).toBe('X_INTERNAL');
    expect(body['cause']).toContain('undefined is not a function');
  });

  test('an onError hook throwing a Proxy that traps getPrototypeOf still answers', async () => {
    const response = await pipelineWith({
      onError: () => {
        throw unreadable();
      },
    }).handle(get('/boom'), { role: 'web' });

    expect(response.status).toBe(500);
    expect((await bodyOf(response))['code']).toBe('X_INTERNAL');
  });

  // The same class one layer down: `factsOf` read `record['code']` unguarded, so a handler
  // throwing this value threw out of the recover stage AND out of the `problem()` the guard
  // answers with — two renderings of one hostile value, neither of which could complete.
  test('a handler throwing an unreadable value is answered, not dropped', async () => {
    const response = await pipelineWith().handle(get('/hostile'), { role: 'web' });

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await bodyOf(response);
    expect(body['code']).toBe('X_INTERNAL');
    expect(body['cause']).toBe('a object that cannot be rendered');
    expect(reporter.events).toHaveLength(1);
  });
});

/**
 * The line `recoverWith` ENDS on, which sat outside its own `try`. Reached directly, because a
 * pipeline can no longer produce a value that breaks it: `statusFor` read a status off
 * `Object.prototype` until 3.0.x, so an app throwing `{ code: 'toString' }` handed `new Response`
 * a function and this exact line raised a `RangeError` — out of the one frame with nothing above
 * it, so `handle()` rejected and the socket got whatever the runtime printed. `error-map.ts` fixes
 * that read; this pins that the frame itself is guarded, for the next reader that is not total.
 */
describe("recoverWith's own fallback is inside the guard", () => {
  test('a context whose fields refuse to be read still answers a 500 problem document', async () => {
    const ctx = { requestId: 'r-1', error: new TypeError('the original defect') };
    Object.defineProperty(ctx, 'url', {
      get: (): never => {
        throw new TypeError('the url is not for you');
      },
    });

    const response = await recoverWith(undefined)(
      {} as unknown as UltimateRequest,
      ctx as unknown as RequestContext,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    const body = await bodyOf(response);
    expect(body['code']).toBe('X_INTERNAL');
    // The `fix` names where the swallowed renderer failure went, because this document cannot
    // carry it: an instruction that stops at "something failed" is not one.
    expect(body['fix']).toContain('pipeline.problem_failed');
    // `lastResort` spells its `type` as a literal, because it calls nothing — this is what keeps
    // that literal equal to what every other problem document carries. It shipped
    // `https://ultimate.dev/errors/X_INTERNAL`, a host that answers 404, until 9.x.
    expect(body['type']).toBe(problemTypeFor('X_INTERNAL'));
    expect(body['type']).not.toContain('ultimate.dev');
  });
});
