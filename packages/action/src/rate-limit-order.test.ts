// Where in `invoke` the declared bucket is spent, and from whose frame. Split from
// `rate-limit-surfaces.test.ts` (which asks WHICH surfaces spend) because this asks WHEN and AS
// WHOM: before the parse and the row load, so a flood of invalid input or row-denied calls is
// refused; never for a replay; and a job run never wears a visitor's address.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, userActor } from '@ultimat3/core';
import type { RateLimitStore } from '@ultimat3/http';
import { installRateLimitStore, memoryRateLimitStore, resetRateLimitStore } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { IdempotencyStore } from './idempotency';
import { MemoryIdempotencyStore } from './idempotency-memory';
import { withCallerAddress } from './rate-limit-gate';

beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

/** A store that records every key it was asked to spend. */
const spying = (): { store: RateLimitStore; keys: string[] } => {
  const inner = memoryRateLimitStore();
  const keys: string[] = [];
  return {
    keys,
    store: {
      scope: inner.scope,
      take: (key, bucket, cost, nowMs) => {
        keys.push(key);
        return inner.take(key, bucket, cost, nowMs);
      },
      peek: (key, bucket, nowMs) => inner.peek(key, bucket, nowMs),
      reset: (key) => inner.reset(key),
    },
  };
};

const ctx = () => createContext({ actor: { ...userActor({ id: 'u1' }), permissions: ['p:w'] } });

describe('the bucket is spent before the parse and the row load', () => {
  test('a flood of invalid input is refused after the limit, not answered 400 forever', async () => {
    const target = action({
      input: t.object({ email: t.email }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      rateLimit: { limit: 2, windowMs: 60_000 },
      handle: () => ({ ok: true }),
    }).named('contactSales');
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(await outcome(target({ email: 'not-an-email' }, { ctx: ctx(), surface: 'mcp' })));
    }
    expect(seen).toEqual(['X_INPUT_INVALID', 'X_INPUT_INVALID', 'X_RATE_LIMITED']);
  });

  test('a refused call never runs the row loader', async () => {
    let loads = 0;
    const target = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: can('p:w', ({ row }) => row !== null && false),
      rateLimit: { limit: 2, windowMs: 60_000 },
      row: () => {
        loads += 1;
        return { id: 'r' };
      },
      handle: () => ({ ok: true }),
    }).named('editPost');
    const caller = ctx();
    for (let i = 0; i < 5; i += 1)
      await outcome(target({ id: 'x' }, { ctx: caller, surface: 'mcp' }));
    expect(loads).toBe(2);
  });
});

describe('an idempotent key spends once, for the run that happens', () => {
  const idempotent = () =>
    action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      idempotent: true,
      rateLimit: { limit: 1, windowMs: 60_000 },
      handle: () => ({ ok: true }),
    }).named('chargeOnce');

  test('a key the store reclaims between the peek and the reservation is still metered', async () => {
    const target = idempotent();
    const caller = ctx();
    expect(
      await outcome(target({ id: 'a' }, { ctx: caller, surface: 'http', idempotencyKey: 'k1' })),
    ).toBe('ok');
    // A stale in-flight record: the peek sees it (a "replay"), the reservation reclaims it.
    const inner = new MemoryIdempotencyStore();
    const released: string[] = [];
    const reclaiming: IdempotencyStore = {
      scope: inner.scope,
      keepsRedaction: true,
      reserve: (key, hash) => inner.reserve(key, hash),
      settle: (key, value, id, redacted) => inner.settle(key, value, id, redacted),
      fail: (key, failure, id) => inner.fail(key, failure, id),
      release: (key) => {
        released.push(key);
        return inner.release(key);
      },
      get: async () =>
        ({
          id: 'stale',
          requestHash: 'x',
          status: 'in-flight',
          value: undefined,
          failure: undefined,
        }) as never,
    };
    const result = await outcome(
      target(
        { id: 'a' },
        { ctx: caller, surface: 'http', idempotencyKey: 'k2', store: reclaiming },
      ),
    );
    expect(result).toBe('X_RATE_LIMITED');
    // The refusal is not the key's outcome: the reservation is given back, so a retry can run.
    expect(released).toHaveLength(1);
  });
});

describe('a job run never wears a visitor’s address', () => {
  const limited = () =>
    action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      rateLimit: { limit: 5, windowMs: 60_000 },
      handle: () => ({ ok: true }),
    }).named('summarize');

  test('a frame leaked into the worker is ignored: the run is unattributed', async () => {
    const spy = spying();
    installRateLimitStore(spy.store);
    // What a `setTimeout` re-arm chain started inside a request carries into the worker loop.
    await withCallerAddress('203.0.113.9', () =>
      limited().job().invoke({ id: 'a' }, createContext({})),
    );
    expect(spy.keys).toEqual(['action:summarize|job:unattributed']);
  });

  test('an action run AS a job calls its tools as the job, not as an anonymous visitor', async () => {
    const spy = spying();
    installRateLimitStore(spy.store);
    const tool = limited();
    const agentLike = action({
      input: t.object({ id: t.string }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: async ({ input }) => {
        await tool(input, { surface: 'mcp' });
        return { ok: true };
      },
    }).named('askAgent');
    await agentLike.job().invoke({ id: 'a' }, createContext({}));
    expect(spy.keys).toEqual(['action:summarize|job:unattributed']);
  });
});
