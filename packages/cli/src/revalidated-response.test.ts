// The unhashed-file answer on its own; the routes that use it are `sw-routes.test.ts` (the register
// script) and `runtime-assets.test.ts` (the icon matrix).

import { describe, expect, test } from 'bun:test';
import {
  defineHttpConfig,
  httpPipeline,
  httpRouter,
  requestContext,
  UltimateRequest,
} from '@ultimat3/http';
import { contentHash } from '@ultimat3/render/server';
import { REVALIDATE_CACHE_CONTROL, revalidatedResponse } from './revalidated-response';

const request = (headers: Record<string, string> = {}): UltimateRequest => {
  const url = new URL('http://dev.test/x-sw-register.js');
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'GET', role: 'web', config });
  return new UltimateRequest(new Request(url, { headers }), ctx);
};

describe('revalidatedResponse', () => {
  test('never immutable: cacheable, but revalidated before every reuse', async () => {
    const response = revalidatedResponse(request(), 'console.log(1)', 'text/javascript');
    expect(response.headers.get('cache-control')).toBe(REVALIDATE_CACHE_CONTROL);
    expect(REVALIDATE_CACHE_CONTROL).not.toContain('immutable');
    expect(await response.text()).toBe('console.log(1)');
  });

  // One identity for a byte string: the ETag a document gets from `contentHash` is the ETag the
  // same bytes get here, whether they arrive as a string or as bytes.
  test('the ETag is the content hash of the bytes, the same from a string or from bytes', () => {
    const text = 'if (1) {}';
    const fromString = revalidatedResponse(request(), text, 'text/javascript');
    const fromBytes = revalidatedResponse(
      request(),
      new TextEncoder().encode(text),
      'text/javascript',
    );
    expect(fromString.headers.get('etag')).toBe(`"${contentHash(text)}"`);
    expect(fromBytes.headers.get('etag')).toBe(fromString.headers.get('etag'));
  });

  test('a matching validator — weak form included — is a 304 with no body', async () => {
    const etag = `"${contentHash('a')}"`;
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
      const response = revalidatedResponse(request({ 'if-none-match': header }), 'a', 'text/plain');
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
    }
  });

  test('a stale validator gets the new bytes', async () => {
    const response = revalidatedResponse(
      request({ 'if-none-match': `"${contentHash('old')}"` }),
      'new',
      'text/plain',
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('new');
  });

  // RFC 9110 §15.4.5, through the real lifecycle so the `compress` stage has its say on both.
  test("under a coding, the 304's validator equals the 200's, byte for byte", async () => {
    const pipeline = httpPipeline({
      table: httpRouter([
        {
          method: 'GET',
          path: '/x-sw-register.js',
          meta: { name: 'register', auth: 'public' },
          handler: (request) =>
            revalidatedResponse(request, 'self.x = 1;\n'.repeat(200), 'text/javascript'),
        },
      ]),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
      hooks: { authenticate: () => null },
    });
    const get = (headers: Record<string, string>) =>
      pipeline.handle(new Request('http://dev.test/x-sw-register.js', { headers }), {
        role: 'web',
      });
    const full = await get({ 'accept-encoding': 'gzip' });
    expect(full.headers.get('content-encoding')).toBe('gzip');
    const tag = full.headers.get('etag') as string;
    const again = await get({ 'accept-encoding': 'gzip', 'if-none-match': tag });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(tag);
  });
});
