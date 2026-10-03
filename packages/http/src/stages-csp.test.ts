// The security stage stamps the app's policy on every response. A handler that set a
// `content-security-policy` of its own — a `sandbox` for an uploaded file served from the app's
// origin — had it OVERWRITTEN, so the stricter policy never reached a browser. Kept now, and the
// app's policy is added beside it: two policies, both enforced, so a handler can only narrow.

import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { createPipeline } from './pipeline';
import { createRateLimiter } from './rate-limit';
import { text } from './response';
import { createRouter, type Route } from './router';

const sandboxed = (): Response =>
  new Response('<script>1</script>', {
    headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' },
  });

const routes: readonly Route[] = [
  {
    method: 'GET',
    path: '/plain',
    meta: { name: 'plain', auth: 'public' },
    handler: () => text('ok'),
  },
  { method: 'GET', path: '/upload', meta: { name: 'upload', auth: 'public' }, handler: sandboxed },
];

const pipelineFor = (reportOnly: boolean) =>
  createPipeline({
    table: createRouter(routes),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      dev: false,
      buildId: null,
      security: { csp: { reportOnly } },
    }),
    limiter: createRateLimiter({
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
