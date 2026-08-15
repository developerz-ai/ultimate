// The declared numbers must be the ENFORCED numbers. Driven through the real server rather than
// through `toRoute`'s meta, because a bucket name nothing registers is exactly what this proves:
// the declaration reached OpenAPI and stopped, and the endpoint ran on `default` — 120 burst.

import { describe, expect, test } from 'bun:test';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toBucket, toOpenApiOperation, toRoute } from './http';

const Input = t.object({ email: t.email });
const Output = t.object({ ok: t.boolean });

/** Fresh per test: one limiter per server, so a test's bucket is its own. */
const contactSales = () =>
  action({
    input: Input,
    output: Output,
    policy: allow(),
    // Five in ten minutes is a contact form's allowance. `default` is 120 burst / 2 per second.
    rateLimit: { limit: 5, windowMs: 600_000 },
    handle: () => ({ ok: true }),
  }).named('contactSales');

const openContact = () =>
  action({
    input: Input,
    output: Output,
    policy: allow(),
    handle: () => ({ ok: true }),
  }).named('contactSales');

const call = (server: ReturnType<typeof createServer>): Promise<Response> =>
  server.fetch(
    new Request('http://dev.test/api/sales/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'buyer@example.test' }),
    }),
  );

/** Statuses for `count` sequential calls — sequential, because a bucket is order-dependent. */
async function drain(
  server: ReturnType<typeof createServer>,
  count: number,
): Promise<readonly number[]> {
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push((await call(server)).status);
  return out;
}

describe('an action rate limit is enforced, not only published', () => {
  test('the sixth call to a limit: 5 action is refused', async () => {
    const server = createServer({ routes: [toRoute(contactSales())] });
    const statuses = await drain(server, 6);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test('the limit header states the declared number, so a client reads what is enforced', async () => {
    const server = createServer({ routes: [toRoute(contactSales())] });
    const response = await call(server);
    expect(response.headers.get('ratelimit-limit')).toBe('5');
  });

  test('the published OpenAPI numbers are the ones the bucket enforces', async () => {
    const target = contactSales();
    const published = target.openapi()['x-ultimate']['rateLimit'] as {
      limit: number;
      windowMs: number;
    };
    expect(published).toEqual({ limit: 5, windowMs: 600_000 });
    const server = createServer({ routes: [toRoute(target)] });
    const statuses = await drain(server, published.limit + 1);
    expect(statuses.filter((status) => status === 200)).toHaveLength(published.limit);
  });

  test('an action that declares nothing keeps the default bucket', async () => {
    const server = createServer({ routes: [toRoute(openContact())] });
    const statuses = await drain(server, 10);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  test('a configured bucket of the same name with other numbers is refused at boot', () => {
    const config = defineHttpConfig({
      rateLimit: {
        buckets: {
          default: { capacity: 120, refillPerSecond: 2 },
          contactSales: { capacity: 120, refillPerSecond: 2 },
        },
      },
    });
    expect(() => createServer({ routes: [toRoute(contactSales())], config })).toThrow(
      /X_RATE_LIMIT_BUCKET_CONFLICT/,
    );
  });

  test('a configured bucket restating the same numbers is accepted', () => {
    const config = defineHttpConfig({
      rateLimit: {
        buckets: { contactSales: toBucket('contactSales', { limit: 5, windowMs: 600_000 }) },
      },
    });
    expect(() => createServer({ routes: [toRoute(contactSales())], config })).not.toThrow();
  });
});

describe('a rate limit the limiter could not run on is refused', () => {
  const declaring = (rateLimit: { limit: number; windowMs: number }) =>
    action({
      input: Input,
      output: Output,
      policy: allow(),
      rateLimit,
      handle: () => ({ ok: true }),
    }).named('contactSales');

  // `windowMs: 0` is an infinite refill — a bucket that never empties, which is the declaration
  // reading as no limit at all. The dangerous direction, and the one this whole slice is about.
  test.each([
    ['an infinite refill', { limit: 5, windowMs: 0 }],
    ['a limit nobody can spend', { limit: 0, windowMs: 60_000 }],
    ['a negative limit', { limit: -1, windowMs: 60_000 }],
    ['a window that is not a number', { limit: 5, windowMs: Number.NaN }],
  ])('%s is X_ACTION_RATE_LIMIT_INVALID', (_label, rateLimit) => {
    expect(() => toRoute(declaring(rateLimit))).toThrow(/X_ACTION_RATE_LIMIT_INVALID/);
  });

  test('the OpenAPI operation refuses the same numbers, so no spec publishes them', () => {
    expect(() => toOpenApiOperation(declaring({ limit: 5, windowMs: 0 }))).toThrow(
      /X_ACTION_RATE_LIMIT_INVALID/,
    );
  });
});
