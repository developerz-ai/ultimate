// The security stage stamps the app's policy on every response. A handler that set a
// `content-security-policy` of its own — a `sandbox` for an uploaded file served from the app's
// origin — had it OVERWRITTEN, so the stricter policy never reached a browser. Kept now, and the
// app's policy is added beside it: two policies, both enforced, so a handler can only narrow.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { rateLimiter } from './rate-limit';
import { textResponse } from './response';
import { httpRouter, type Route } from './router';

const sandboxed = (): Response =>
  new Response('<script>1</script>', {
    headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' },
  });

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/plain',
    meta: { name: 'plain', auth: 'public' },
    handler: () => textResponse('ok'),
  },
  { method: 'GET', path: '/upload', meta: { name: 'upload', auth: 'public' }, handler: sandboxed },
  {
    method: 'GET',
    path: '/referrer/:policy',
    meta: { name: 'referrer', auth: 'public' },
    handler: (request) =>
      new Response('x', {
        headers: { 'referrer-policy': request.ctx.params['policy'] ?? '' },
      }),
  },
];

const pipelineFor = (reportOnly: boolean) =>
  httpPipeline({
    table: httpRouter(routes),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      security: { csp: { reportOnly } },
    }),
    limiter: rateLimiter({
      config: {
        enabled: false,
        defaultBucket: 'default',
        tenantBucket: null,
        scope: 'process',
        buckets: { default: { capacity: 100, refillPerSecond: 1 } },
      },
    }),
    hooks: {},
  });

const get = (pipeline: ReturnType<typeof pipelineFor>, path: string) =>
  pipeline.handle(new Request(`http://localhost${path}`), { role: 'web' });

describe('unit · a handler-set content-security-policy', () => {
  test('is kept, and the app policy is enforced beside it', async () => {
    const csp = (await get(pipelineFor(false), '/upload')).headers.get('content-security-policy');
    expect(csp).toContain('sandbox');
    expect(csp).toContain("default-src 'self'");
  });

  test('a response with none still gets exactly the app policy', async () => {
    const csp = (await get(pipelineFor(false), '/plain')).headers.get('content-security-policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain('sandbox');
  });

  test('under report-only the handler policy is still enforced, the app policy reported', async () => {
    const response = await get(pipelineFor(true), '/upload');
    expect(response.headers.get('content-security-policy')).toBe('sandbox');
    expect(response.headers.get('content-security-policy-report-only')).toContain(
      "default-src 'self'",
    );
  });
});

describe('unit · a handler-set referrer-policy', () => {
  test('no-referrer is kept: it only narrows, and a bearer URL must leave in no Referer', async () => {
    const response = await get(pipelineFor(false), '/referrer/no-referrer');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  test('anything wider is the app policy, so a handler cannot loosen it', async () => {
    const response = await get(pipelineFor(false), '/referrer/unsafe-url');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });
});
