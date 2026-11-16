// The pipeline's edges: the proxy-aware request, the csrf stage, a throwable whose code is a name
// on Object.prototype, and a caller that goes away mid-request. Split from pipeline-hardening.test.ts.

import { describe, expect, test } from 'bun:test';
import { throwIfAborted } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { httpPipeline } from './pipeline';
import { jsonResponse, textResponse } from './response';
import { type HttpMethod, httpRouter, type Route, type RouteHandler } from './router';

const routeWith = (handler: RouteHandler, method: HttpMethod = 'GET'): readonly Route[] => [
  { method, path: '/probe', meta: { name: 'probe', auth: 'public' }, handler },
];

const pipelineFor = (handler: RouteHandler, input: HttpConfigInput = {}, method?: HttpMethod) =>
  httpPipeline({
    table: httpRouter(routeWith(handler, method)),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      ...input,
    }),
    hooks: { authenticate: () => ({ id: 'u1' }) as never },
  });

const call = (
  pipeline: ReturnType<typeof httpPipeline>,
  init: RequestInit = {},
): Promise<Response> =>
  pipeline.handle(new Request('http://app.test/probe', init), { role: 'web' });

// --- H1: the context published through ALS is a REAL Ctx --------------------------------------
// `asCtx` was `as unknown as Ctx` over an object missing five members. `ctx.now()` threw on every
// audited action served over HTTP, and the audit trail the flag was turned on for stayed empty.

// --- H6: the caller behind a proxy ------------------------------------------------------------
describe('the proxy-aware request', () => {
  test('the forwarded client address reaches ctx.ip, not the proxy address', async () => {
    const pipeline = pipelineFor((_request, ctx) => jsonResponse({ ip: ctx.ip }), {
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
    const pipeline = pipelineFor((_request, ctx) => jsonResponse({ ip: ctx.ip }));
    const response = await pipeline.handle(
      new Request('http://app.test/probe', { headers: { 'x-forwarded-for': '203.0.113.9' } }),
      { role: 'web', ip: '10.42.0.7' },
    );
    expect(await response.json()).toEqual({ ip: '10.42.0.7' });
  });

  // HSTS is emitted only when https is AFFIRMED, and behind a TLS-terminating ingress the
  // internal hop is plain http — so the two-year policy went out on no request at all.
  test('x-forwarded-proto: https is what finally emits HSTS', async () => {
    const pipeline = pipelineFor(() => textResponse('ok'), {
      trustProxy: true,
      trustedProxyHops: 1,
    });
    expect((await call(pipeline)).headers.get('strict-transport-security')).toBeNull();
    const behindTls = await call(pipeline, { headers: { 'x-forwarded-proto': 'https' } });
    expect(behindTls.headers.get('strict-transport-security')).toContain('max-age=');
  });
});

// --- H7: CSRF ---------------------------------------------------------------------------------
describe('the csrf stage', () => {
  const post = (init: RequestInit, input: HttpConfigInput = {}) =>
    pipelineFor(() => textResponse('written'), input, 'POST').handle(
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

  // Slice 11 k: `curl -X POST` against `x dev` carries neither header, and the fix it got named a
  // token dev does not have. From a loopback address the fix names the header that proves it.
  test('a local caller with neither header is told the one header that proves same-origin', async () => {
    const local = await pipelineFor(() => textResponse('written'), {}, 'POST').handle(
      new Request('http://localhost:3000/probe', { method: 'POST' }),
      { role: 'web', ip: '127.0.0.1' },
    );
    const body = (await local.json()) as { code: string; fix: string };
    expect(body.code).toBe('X_CSRF_BLOCKED');
    expect(body.fix).toStartWith("curl -H 'sec-fetch-site: same-origin'");
    const remote = await pipelineFor(() => textResponse('written'), {}, 'POST').handle(
      new Request('http://app.test/probe', { method: 'POST' }),
      { role: 'web', ip: '203.0.113.9' },
    );
    expect(((await remote.json()) as { fix: string }).fix).not.toContain('sec-fetch-site');
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
    pipeline: ReturnType<typeof httpPipeline>;
    client: AbortController;
  } => {
    const client = new AbortController();
    const pipeline = pipelineFor(async () => {
      // The tab closes mid-handler; the handler then reaches the next checkpoint, exactly as an
      // app is told to write it (`fetch(url, { signal: ctx.signal })`, `throwIfAborted(ctx)`).
      client.abort();
      await Bun.sleep(0);
      throwIfAborted();
      return jsonResponse({ finished: true });
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
        return jsonResponse({ finished: true });
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
