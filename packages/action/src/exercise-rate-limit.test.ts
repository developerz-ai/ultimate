// The contract exercise spends from no bucket a later test reads: its runs count in a scratch store
// of their own, so the same file's next HTTP call is not a 429 the exercise left behind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer, installedRateLimitStore } from '@ultimat3/http';
import { resetRateLimitStore } from '@ultimat3/http/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { exerciseAction } from './exercise';
import { toRoute } from './http';

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

const limited = action({
  input: t.object({ email: t.email }),
  output: t.object({ ok: t.boolean }),
  policy: allow(),
  rateLimit: { limit: 2, windowMs: 60_000 },
  handle: () => ({ ok: true }),
}).named('exRateContact');

const post = (): Promise<Response> =>
  httpServer({
    routes: [toRoute(limited)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  }).fetch(
    new Request(`http://dev.test${toRoute(limited).path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.test' }),
    }),
  );

describe('the contract exercise and the rate-limit store', () => {
  test('after the exercise, the next HTTP call still has the whole declared limit', async () => {
    const store = installedRateLimitStore();
    await exerciseAction(limited, { actor: null });
    expect(installedRateLimitStore()).toBe(store);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get('ratelimit-remaining')).toBe('1');
  });
});
