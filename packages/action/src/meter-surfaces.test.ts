// One declared `meter:`, one counter, every surface — HTTP, MCP, a job, an in-process call — drawn
// inside `invoke` after the policy admitted the call and before the handler starts, and never twice
// for one idempotent write however often it is retried.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, runWithContext, userActor } from '@ultimat3/core';
import { defineHttpConfig, httpServer, resetRateLimitStore } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';
import { resetIdempotency } from './idempotency';
import { invoke } from './invoke';
import { resetMeterStore } from './meter-store';

beforeEach(() => {
  resetMeterStore();
  resetIdempotency();
  resetRateLimitStore();
});
afterEach(() => resetMeterStore());

const NOW = '2026-11-06T22:00:00.000Z';
const ORG = 'org-acme';

let runs = 0;
const metered = (limit = 2) =>
  action({
    input: t.object({ n: t.number.int() }),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    idempotent: true,
    meter: { name: 'calls', period: 'day', limit },
    mcp: { expose: true, description: 'a metered call' },
    handle: () => {
      runs += 1;
      return { ok: true };
    },
  }).named('meteredCall');

const caller = (clock = frozenClock(NOW), orgId = ORG): Ctx =>
  ctxOf({
    actor: { ...userActor({ id: `u-${orgId}`, orgId }), permissions: ['calls:make'] },
    clock,
  });

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

const codeAndMeta = async (attempt: Promise<unknown>) => {
  try {
    await attempt;
  } catch (error) {
    const coded = error as { code: string; meta: Record<string, unknown> };
    return { code: coded.code, meta: coded.meta };
  }
  return expect.unreachable('the call was expected to be refused');
};

describe('a meter is drawn on every surface, from one counter', () => {
  // The pipeline builds the request's own context — anonymous, the system clock — so the counter
  // here is the shared anonymous one and the reset is whatever is left of today, UTC.
  test('HTTP: 200, 200, then 429 X_METER_EXCEEDED with Retry-After to the UTC midnight', async () => {
    const route = toRoute(metered());
    const app = httpServer({
      routes: [route],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 3; i += 1) {
      last = await app.fetch(
        new Request(`http://dev.test${route.path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ n: i }),
        }),
      );
      statuses.push(last.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    if (last === undefined) return expect.unreachable('three calls answer three responses');
    expect(((await last.json()) as { code: string }).code).toBe('X_METER_EXCEEDED');
    const retryAfter = Number(last.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(86_400);
  });

  test('the refusal carries meta.meter, meta.limit and meta.resetsAt', async () => {
    const target = metered(1);
    const ctx = caller();
    await target({ n: 1 }, { ctx });
    expect(await codeAndMeta(target({ n: 2 }, { ctx }))).toEqual({
      code: 'X_METER_EXCEEDED',
      meta: {
        meter: 'calls',
        limit: 1,
        resetsAt: '2026-11-07T00:00:00.000Z',
        retryAfterSeconds: 7200,
      },
    });
  });

  test('MCP, a job and an in-process call draw on ONE counter for one tenant', async () => {
    const target = metered(3);
    const ctx = caller();
    const seen = [
      await runWithContext(ctx, () => outcome(invoke(target, { n: 1 }, { surface: 'mcp' }))),
      await outcome(target.job().invoke({ n: 2 }, ctx)),
      // `surface: 'server'` spends no rate limit, but usage is usage: it draws.
      await outcome(target({ n: 3 }, { ctx })),
      await outcome(target({ n: 4 }, { ctx, surface: 'http' })),
    ];
    expect(seen).toEqual(['ok', 'ok', 'ok', 'X_METER_EXCEEDED']);
  });

  test('tenants are separate counters, and the next UTC day starts from zero', async () => {
    const clock = frozenClock(NOW);
    const target = metered(1);
    expect(await outcome(target({ n: 1 }, { ctx: caller(clock) }))).toBe('ok');
    expect(await outcome(target({ n: 1 }, { ctx: caller(clock, 'org-other') }))).toBe('ok');
    expect(await outcome(target({ n: 2 }, { ctx: caller(clock) }))).toBe('X_METER_EXCEEDED');
    clock.advance(2 * 3_600_000);
    expect(await outcome(target({ n: 3 }, { ctx: caller(clock) }))).toBe('ok');
  });
});

describe('a meter counts calls the handler was reached for, once', () => {
  test('an idempotent replay draws nothing: the same key three times is one call', async () => {
    const target = metered(2);
    const ctx = caller();
    for (let i = 0; i < 3; i += 1) {
      await target({ n: 1 }, { ctx, idempotencyKey: 'k-1' });
    }
    // One draw left, not none.
    expect(await outcome(target({ n: 2 }, { ctx }))).toBe('ok');
    expect(await outcome(target({ n: 3 }, { ctx }))).toBe('X_METER_EXCEEDED');
  });

  test('a refused keyed call releases its key: the same key runs once the allowance is back', async () => {
    const clock = frozenClock(NOW);
    const target = metered(1);
    const ctx = caller(clock);
    await target({ n: 1 }, { ctx });
    expect(await outcome(target({ n: 2 }, { ctx, idempotencyKey: 'k-2' }))).toBe(
      'X_METER_EXCEEDED',
    );
    clock.advance(2 * 3_600_000);
    expect(await outcome(target({ n: 2 }, { ctx: caller(clock), idempotencyKey: 'k-2' }))).toBe(
      'ok',
    );
  });

  test('a call refused by its policy or its input uses none of the allowance', async () => {
    const guarded = action({
      input: t.object({ n: t.number.int() }),
      output: t.object({ ok: t.boolean }),
      policy: can<{ n: number }>('calls:make', ({ input }) => input.n > 0),
      meter: { name: 'guarded', period: 'day', limit: 1 },
      handle: () => ({ ok: true }),
    }).named('guardedCall');
    const ctx = caller();
    expect(await outcome(guarded({ n: 0 }, { ctx }))).toBe('X_FORBIDDEN');
    expect(await outcome(guarded({ n: 'x' } as never, { ctx }))).toBe('X_INPUT_INVALID');
    expect(await outcome(guarded({ n: 1 }, { ctx }))).toBe('ok');
  });

  test('N parallel calls at the edge never pass the limit, and only those run the handler', async () => {
    const target = metered(5);
    const ctx = caller();
    runs = 0;
    const seen = await Promise.all(
      Array.from({ length: 40 }, (_, n) => outcome(target({ n }, { ctx }))),
    );
    expect(seen.filter((code) => code === 'ok')).toHaveLength(5);
    expect(seen.filter((code) => code === 'X_METER_EXCEEDED')).toHaveLength(35);
    expect(runs).toBe(5);
  });
});
