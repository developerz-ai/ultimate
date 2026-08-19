// Every test here goes through `pipeline.handle` — the real lifecycle, the real ALS scope, the
// real span. That is the point: each of these defects shipped BECAUSE the tests around it built
// a context by hand (core's `createContext`) or asserted on a response and never on the span, so
// the pipeline's own answer was the one thing nothing exercised.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ReadableSpan } from '@ultimat3/core';
import {
  beginWork,
  configureTelemetry,
  drain,
  markReady,
  memoryExporter,
  resetLifecycle,
  resetTelemetry,
  throwIfAborted,
  useContext,
  useService,
} from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { createPipeline } from './pipeline';
import { json, text } from './response';
import { createRouter, type HttpMethod, type Route, type RouteHandler } from './router';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

const routeWith = (handler: RouteHandler, method: HttpMethod = 'GET'): readonly Route[] => [
  { method, path: '/probe', meta: { name: 'probe', auth: 'public' }, handler },
];

const pipelineFor = (handler: RouteHandler, input: HttpConfigInput = {}, method?: HttpMethod) =>
  createPipeline({
    table: createRouter(routeWith(handler, method)),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      ...input,
    }),
    hooks: { authenticate: () => ({ id: 'u1' }) as never },
  });

const call = (
  pipeline: ReturnType<typeof createPipeline>,
  init: RequestInit = {},
): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/probe', init), { role: 'web' });

// --- H1: the context published through ALS is a REAL Ctx --------------------------------------
// `asCtx` was `as unknown as Ctx` over an object missing five members. `ctx.now()` threw on every
// audited action served over HTTP, and the audit trail the flag was turned on for stayed empty.
describe('the ambient context is core Ctx, in full', () => {
  test('ctx.now() answers a Date instead of throwing "not a function"', async () => {
    const pipeline = pipelineFor(() => json({ at: useContext().now().toISOString() }));
    const response = await call(pipeline);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { at: string };
    expect(Number.isNaN(Date.parse(body.at))).toBe(false);
  });

  test('throwIfAborted() reads a live signal instead of TypeError on undefined', async () => {
    const pipeline = pipelineFor(() => {
      throwIfAborted();
      return text('not aborted');
    });
    expect(await (await call(pipeline)).text()).toBe('not aborted');
  });

  test('useService() raises its own X_SERVICE_MISSING, not a TypeError', async () => {
    const pipeline = pipelineFor(() => {
      useService('mailer');
      return text('unreachable');
    });
    const body = (await (await call(pipeline)).json()) as { code: string };
    expect(body.code).toBe('X_SERVICE_MISSING');
  });

  test('ctx.logger and ctx.clock are real, not undefined', async () => {
    const pipeline = pipelineFor(() =>
      json({ logger: typeof useContext().logger.info, clock: typeof useContext().clock.now }),
    );
    expect(await (await call(pipeline)).json()).toEqual({ logger: 'function', clock: 'function' });
  });

  // `Ctx.buildId` means the build this PROCESS serves. The request context reused the name for
  // the CLIENT's claim, so once `asCtx` was checked the caller's header would have been what
  // every `ctx.buildId` reader in the framework saw.
  test('ctx.buildId is the process build; the client claim is request.buildId', async () => {
    const pipeline = pipelineFor(
      (request, ctx) => json({ ctx: ctx.buildId, client: request.buildId }),
      { buildId: 'server-7' },
    );
    const response = await call(pipeline, { headers: { 'x-ultimate-build': 'server-7' } });
    expect(await response.json()).toEqual({ ctx: 'server-7', client: 'server-7' });
  });
});

// --- H2: the root span continues the caller's trace -------------------------------------------
describe('the root span', () => {
  const exporter = memoryExporter();
  beforeEach(() => {
    exporter.reset();
    configureTelemetry({ exporter });
  });
  afterEach(() => resetTelemetry());

  const spanOf = (): ReadableSpan => {
    const span = exporter.spans[0];
    if (span === undefined) throw new Error('no span was exported');
    return span;
  };

  // The defect, measured: the header said 4bf92f… and the span said 01a00ac1-92d6-707f-… with no
  // parent — logs and traces naming two different trace ids for one request.
  test('adopts an inbound traceparent as its parent, on the same trace', async () => {
    const response = await call(
      pipelineFor(() => text('ok')),
      {
        headers: { traceparent: TRACEPARENT },
      },
    );
    expect(response.headers.get('x-trace-id')).toBe(TRACE_ID);
    expect(spanOf().context.traceId).toBe(TRACE_ID);
    expect(spanOf().parentSpanId).toBe('00f067aa0ba902b7');
  });

  test('with no inbound trace the span id is 32 hex, and the header agrees with it', async () => {
    const response = await call(pipelineFor(() => text('ok')));
    expect(spanOf().context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers.get('x-trace-id')).toBe(spanOf().context.traceId);
    expect(spanOf().parentSpanId).toBeUndefined();
  });

  // What a reader joins on. `ctx.traceId` is the field core's log injector reads, so the span
  // agreeing with the response header is the same claim as the log lines agreeing with the span.
  test('ctx.traceId, the span and the response header are one value', async () => {
    let seen = '';
    const response = await call(
      pipelineFor(() => {
        seen = useContext().traceId;
        return text('ok');
      }),
      { headers: { traceparent: TRACEPARENT } },
    );
    expect(seen).toBe(TRACE_ID);
    expect(spanOf().context.traceId).toBe(seen);
    expect(response.headers.get('x-trace-id')).toBe(seen);
  });
});

// --- H3: the request deadline -----------------------------------------------------------------
describe('the request deadline', () => {
  test('a handler that never finishes is answered 504, not held forever', async () => {
    const pipeline = pipelineFor(
      async () => {
        await new Promise<void>(() => undefined);
        return text('never');
      },
      { requestTimeoutMs: 20 },
    );
    const response = await call(pipeline);
    expect(response.status).toBe(504);
    expect(((await response.json()) as { code: string }).code).toBe('X_TIMEOUT');
  });

  test('ctx.signal aborts, so cooperative code can unwind on its own', async () => {
    const pipeline = pipelineFor(
      async () => {
        const ctx = useContext();
        await Bun.sleep(40);
        throwIfAborted(ctx);
        return text('never');
      },
      { requestTimeoutMs: 15 },
    );
    // Either half may answer first — the abort's X_ABORTED (499) or the deadline's 504. Both say
    // "nobody is waiting on this", and neither is a connection held open.
    expect([499, 504]).toContain((await call(pipeline)).status);
  });

  test('a fast handler is untouched', async () => {
    const pipeline = pipelineFor(() => text('quick'), { requestTimeoutMs: 1_000 });
    expect(await (await call(pipeline)).text()).toBe('quick');
  });

  test('requestTimeoutMs: 0 is a deployment that would rather hold the connection', async () => {
    const pipeline = pipelineFor(
      async () => {
        await Bun.sleep(20);
        return text('slow but served');
      },
      { requestTimeoutMs: 0 },
    );
    expect(await (await call(pipeline)).text()).toBe('slow but served');
  });
});

// --- H4: load shedding, and the drain 503 the package docs already claimed --------------------
describe('the admit stage', () => {
  afterEach(() => resetLifecycle());

  test('answers 503 with Retry-After while the process is draining', async () => {
    const pipeline = pipelineFor(() => text('ok'));
    markReady();
    await drain('test');
    const response = await call(pipeline);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(((await response.json()) as { code: string }).code).toBe('X_DRAINING');
  });

  // `beginWork()` is core's, and `server.ts` calls it around every dispatch — so the count the
  // stage reads is the fleet's own in-flight number, not one this package keeps privately.
  test('sheds past maxInflight before the route is matched at all', async () => {
    let reached = false;
    const pipeline = pipelineFor(
      () => {
        reached = true;
        return text('ok');
      },
      { maxInflight: 1 },
    );
    const held = [beginWork(), beginWork()];
    try {
      const response = await call(pipeline);
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('X_OVERLOADED');
      expect(response.headers.get('retry-after')).toBe('1');
      expect(reached).toBe(false);
    } finally {
      for (const done of held) done();
    }
  });

  test('under the ceiling nothing is shed', async () => {
    const pipeline = pipelineFor(() => text('ok'), { maxInflight: 10 });
    expect((await call(pipeline)).status).toBe(200);
  });

  test('maxInflight: 0 disables the ceiling', async () => {
    const pipeline = pipelineFor(() => text('ok'), { maxInflight: 0 });
    const held = [beginWork(), beginWork(), beginWork()];
    try {
      expect((await call(pipeline)).status).toBe(200);
    } finally {
      for (const done of held) done();
    }
  });
});

// --- H6: the caller behind a proxy ------------------------------------------------------------
describe('the proxy-aware request', () => {
  test('the forwarded client address reaches ctx.ip, not the proxy address', async () => {
    const pipeline = pipelineFor((_request, ctx) => json({ ip: ctx.ip }), {
      trustProxy: true,
      trustedProxyHops: 1,
    });
    const response = await pipeline.handle(
      new Request('http://app.test/probe', { headers: { 'x-forwarded-for': '203.0.113.9' } }),
      { role: 'web', ip: '10.42.0.7' },
    );
    expect(await response.json()).toEqual({ ip: '203.0.113.9' });
  });

  test('untrusted, the header is ignored and the socket address stands', async () => {
    const pipeline = pipelineFor((_request, ctx) => json({ ip: ctx.ip }));
    const response = await pipeline.handle(
      new Request('http://app.test/probe', { headers: { 'x-forwarded-for': '203.0.113.9' } }),
      { role: 'web', ip: '10.42.0.7' },
    );
    expect(await response.json()).toEqual({ ip: '10.42.0.7' });
  });

  // HSTS is emitted only when https is AFFIRMED, and behind a TLS-terminating ingress the
  // internal hop is plain http — so the two-year policy went out on no request at all.
  test('x-forwarded-proto: https is what finally emits HSTS', async () => {
    const pipeline = pipelineFor(() => text('ok'), { trustProxy: true, trustedProxyHops: 1 });
    expect((await call(pipeline)).headers.get('strict-transport-security')).toBeNull();
    const behindTls = await call(pipeline, { headers: { 'x-forwarded-proto': 'https' } });
    expect(behindTls.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

// --- H7: CSRF ---------------------------------------------------------------------------------
describe('the csrf stage', () => {
  const post = (init: RequestInit, input: HttpConfigInput = {}) =>
    pipelineFor(() => text('written'), input, 'POST').handle(
      new Request('http://app.test/probe', { method: 'POST', ...init }),
      { role: 'web' },
    );

  test('a cross-site form post from a signed-in browser is refused 403', async () => {
    const response = await post({
      headers: {
        'sec-fetch-site': 'cross-site',
        origin: 'https://evil.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'amount=100',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('X_CSRF_BLOCKED');
  });

  test('the same post from the app own pages goes through', async () => {
    const response = await post({
      headers: {
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'amount=100',
    });
    expect(await response.text()).toBe('written');
  });

  test('a bearer caller carries no ambient credential and needs no origin', async () => {
    expect(await (await post({ headers: { authorization: 'Bearer t' } })).text()).toBe('written');
  });

  test("mode: 'off' lets it through — declared, never discovered", async () => {
    const response = await post(
      { headers: { 'sec-fetch-site': 'cross-site' } },
      {
        csrf: { mode: 'off' },
      },
    );
    expect(await response.text()).toBe('written');
  });
});

// --- H12: `handle` answers, whatever the app threw ---------------------------------------------
// `statusFor` read `ERROR_STATUS[code]` off the PROTOTYPE chain, so a throwable carrying
// `code: 'toString'` produced a function where a status belongs. `new Response(body, { status })`
// then raised a `RangeError` inside `recoverWith`'s fallback — outside its own `try`, in the one
// frame with nothing above it — so `Pipeline.handle` REJECTED, `server.ts`'s `dispatch` rejected
// with it, and the socket got whatever the runtime printed. A `code` is a string read off a value
// this package did not build: one app throwing an object literal is the whole exploit.
describe('a throwable whose code is a name on Object.prototype', () => {
  const INHERITED = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];

  test('is answered with the coded 500, never a rejected handle()', async () => {
    for (const code of INHERITED) {
      const pipeline = pipelineFor(() => {
        // Deliberately not an `UltimateError`: the defect is that nothing here built the value.
        throw { code, message: 'thrown by the app' };
      });
      const response = await call(pipeline);
      expect(response.status, `status for ${code}`).toBe(500);
      expect(((await response.json()) as { code: string }).code).toBe(code);
    }
  });
});

// --- H13: `ctx.signal` is BOTH halves it is documented as ---------------------------------------
// `context.ts` promised "aborted when the caller goes away or the request deadline passes" and
// only the deadline half existed: nothing in the package read the inbound `Request.signal`, so a
// browser closing the tab left the handler running for the whole `requestTimeoutMs` — 30s of a DB
// pool slot and a vendor connection held for a caller that is gone.
describe('a caller that goes away', () => {
  const abortable = (): {
    pipeline: ReturnType<typeof createPipeline>;
    client: AbortController;
  } => {
    const client = new AbortController();
    const pipeline = pipelineFor(async () => {
      // The tab closes mid-handler; the handler then reaches the next checkpoint, exactly as an
      // app is told to write it (`fetch(url, { signal: ctx.signal })`, `throwIfAborted(ctx)`).
      client.abort();
      await Bun.sleep(0);
      throwIfAborted();
      return json({ finished: true });
    });
    return { pipeline, client };
  };

  test('aborts ctx.signal, so the handler unwinds with X_ABORTED instead of finishing', async () => {
    const { pipeline, client } = abortable();
    const response = await pipeline.handle(
      new Request('http://app.test/probe', { signal: client.signal }),
      { role: 'web' },
    );
    expect(response.status).toBe(499);
    expect(((await response.json()) as { code: string }).code).toBe('X_ABORTED');
  });

  test('and with requestTimeoutMs: 0 too — no deadline is not "no signal"', async () => {
    const client = new AbortController();
    const pipeline = pipelineFor(
      async () => {
        client.abort();
        await Bun.sleep(0);
        throwIfAborted();
        return json({ finished: true });
      },
      { requestTimeoutMs: 0 },
    );
    const response = await pipeline.handle(
      new Request('http://app.test/probe', { signal: client.signal }),
      { role: 'web' },
    );
    expect(response.status).toBe(499);
  });
});
