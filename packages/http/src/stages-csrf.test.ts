// The `csrf` stage hands checkCsrf the request's real `Authorization` header: a cookie session
// behind a staging proxy's Basic auth is still origin-checked, a bearer caller still is not.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { defineHttpConfig } from './config';
import { httpPipeline } from './pipeline';
import { textResponse } from './response';
import { httpRouter } from './router';

const member = { id: 'u1' } as unknown as Actor;

const pipeline = httpPipeline({
  table: httpRouter([
    {
      method: 'POST',
      path: '/orders/refund',
      meta: { name: 'refund', auth: 'public' },
      handler: () => textResponse('refunded'),
    },
  ]),
  config: defineHttpConfig({ dev: false, buildId: null, rateLimit: { scope: 'process' } }),
  hooks: { authenticate: (request) => (request.cookie('sid') === 'u1' ? member : null) },
});

const siblingPost = (authorization: string) =>
  pipeline.handle(
    new Request('https://app.example.com/orders/refund', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.app.example.com',
        'sec-fetch-site': 'same-site',
        cookie: 'sid=u1',
        authorization,
      },
      body: 'amount=1',
    }),
    { role: 'web', ip: '203.0.113.9' },
  );

describe('csrf stage, Authorization header', () => {
  test('a cached Basic credential beside the session cookie does not exempt the write', async () => {
    const response = await siblingPost('Basic c3RhZ2luZzpwdw==');
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('X_CSRF_BLOCKED');
  });

  test('a bearer token does', async () => {
    const response = await siblingPost('Bearer t0k');
    expect(response.status).toBe(200);
  });
});
