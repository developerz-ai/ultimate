// `rateLimit.limit` resolved per call from `ctx`: each tenant gets its own plan's burst, a resolver
// that answers no usable number is `X_RATE_LIMIT_INVALID` before any bucket is touched, and the
// declaration publishes as data without inventing a number it does not have.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, userActor } from '@ultimat3/core';
import { resetRateLimitStore } from '@ultimat3/http/adapter';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { ActionRateLimit } from './action';
import { action } from './action';
import { toRoute } from './http';

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

const PER_MINUTE = new Map([
  ['org-free', 1],
  ['org-team', 3],
]);

const limited = (rateLimit: ActionRateLimit) =>
  action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    rateLimit,
    handle: () => ({ ok: true }),
  }).named('planLimited');

const caller = (orgId: string): Ctx =>
  ctxOf({ actor: userActor({ id: `u-${orgId}`, orgId }), clock: frozenClock(0) });

const outcomes = async (target: ReturnType<typeof limited>, ctx: Ctx, n: number) => {
  const seen: string[] = [];
  for (let i = 0; i < n; i += 1) {
    seen.push(
      await target({}, { ctx, surface: 'http' }).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code ?? 'uncoded',
      ),
    );
  }
  return seen;
};

describe('a rate limit resolved per call', () => {
  test("each tenant's burst is its plan's", async () => {
    const target = limited({
      windowMs: 60_000,
      limit: ({ ctx }) => PER_MINUTE.get(ctx.actor.orgId ?? '') ?? 1,
    });
    expect(await outcomes(target, caller('org-free'), 2)).toEqual(['ok', 'X_RATE_LIMITED']);
    expect(await outcomes(target, caller('org-team'), 4)).toEqual([
      'ok',
      'ok',
      'ok',
      'X_RATE_LIMITED',
    ]);
  });

  test.each([Number.NaN, 0, Number.POSITIVE_INFINITY, 'ten'])(
    'a resolver answering %p is X_RATE_LIMIT_INVALID, never allow-all or block-all',
    async (bad) => {
      const target = limited({ windowMs: 60_000, limit: () => bad as number });
      expect(await outcomes(target, caller('org-free'), 1)).toEqual(['X_RATE_LIMIT_INVALID']);
    },
  );

  test('a server call resolves nothing and spends nothing', async () => {
    let asked = 0;
    const target = limited({
      windowMs: 60_000,
      limit: () => {
        asked += 1;
        return 1;
      },
    });
    await target({}, { ctx: caller('org-free') });
    expect(asked).toBe(0);
  });

  test('a bad window is still refused at mount, resolver or not', () => {
    let code: unknown;
    try {
      toRoute(limited({ windowMs: 0, limit: () => 5 }));
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('X_RATE_LIMIT_INVALID');
  });

  test('describe() keeps the fixed pair; a per-call limit publishes its window alone', () => {
    const fixed = limited({ limit: 5, windowMs: 60_000 }).describe();
    expect(fixed.rateLimit).toEqual({ limit: 5, windowMs: 60_000 });
    expect(fixed.rateLimitPerCall).toBeNull();
    const perCall = limited({ limit: () => 5, windowMs: 60_000 });
    expect([perCall.describe().rateLimit, perCall.describe().rateLimitPerCall]).toEqual([
      null,
      { windowMs: 60_000 },
    ]);
    expect(perCall.openapi()['x-ultimate']).toMatchObject({
      rateLimit: { limit: 'per-call', windowMs: 60_000 },
    });
  });
});
