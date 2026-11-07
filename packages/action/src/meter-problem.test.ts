// What an HTTP caller refused by a meter can READ: the problem document carries `meta.meter`,
// `meta.limit` and `meta.resetsAt` — `@ultimat3/http`'s reviewed framework row — and nothing else
// off the error. Also the producer half of that row: every key it names, this error must set.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { defineHttpConfig, httpServer, resetRateLimitStore, toProblem } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { MeterExceededError } from './errors-meter';
import { toRoute } from './http';
import { resetMeterStore } from './meter-store';

beforeEach(() => {
  resetMeterStore();
  resetRateLimitStore();
});
afterEach(() => resetMeterStore());

const exceeded = () =>
  new MeterExceededError({
    action: 'createPost',
    meter: 'posts',
    period: 'day',
    limit: 100,
    resetsAtMs: Date.UTC(2026, 10, 7),
    nowMs: Date.UTC(2026, 10, 6, 22),
  });

describe('X_METER_EXCEEDED on the wire', () => {
  // The producer half of the row too: a key renamed here would drop out of this exact equality.
  test('the document carries meter, limit and resetsAt, and not retryAfterSeconds', () => {
    const problem = toProblem(exceeded());
    expect(problem.meta).toEqual({
      meter: 'posts',
      limit: 100,
      resetsAt: '2026-11-07T00:00:00.000Z',
    });
    expect(JSON.stringify(problem)).not.toContain('retryAfterSeconds');
  });

  test('a real 429 over HTTP answers the meta and the Retry-After beside it', async () => {
    const route = toRoute(
      action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: allow(),
        meter: { name: 'pings', period: 'hour', limit: 0 },
        handle: () => ({ ok: true }),
      }).named('meteredPing'),
    );
    const app = httpServer({
      routes: [route],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    const response = await app.fetch(
      new Request(`http://dev.test${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = (await response.json()) as { code: string; meta?: Record<string, unknown> };
    expect(body.code).toBe('X_METER_EXCEEDED');
    expect(Object.keys(body.meta ?? {}).sort()).toEqual(['limit', 'meter', 'resetsAt']);
    expect(body.meta?.['meter']).toBe('pings');
    expect(body.meta?.['limit']).toBe(0);
  });
});
