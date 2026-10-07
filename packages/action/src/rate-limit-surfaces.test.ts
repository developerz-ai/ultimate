// One declared `rateLimit:`, one bucket, every surface. The limit used to be a route meta field the
// HTTP pipeline read and nothing else did, so the same action called ten times over MCP, by the
// in-app agent, or as a queued job answered ten times. `invoke` is the one place all four meet.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { anonymousActor, ctxOf, frozenClock, runWithContext, userActor } from '@ultimat3/core';
import type { RateLimitStore } from '@ultimat3/http';
import {
  defineHttpConfig,
  httpServer,
  installRateLimitStore,
  memoryRateLimitStore,
  resetRateLimitStore,
} from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';
import { invoke } from './invoke';

// The store is process-wide, and so is the test runner: another file's spend must not be ours.
beforeEach(() => resetRateLimitStore());
afterEach(() => resetRateLimitStore());

/** Two per minute — small enough that every surface below reaches the refusal in three calls. */
const limited = () =>
  action({
    input: t.object({ email: t.email }),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    rateLimit: { limit: 2, windowMs: 60_000 },
    mcp: { expose: true, description: 'contact sales' },
    handle: () => ({ ok: true }),
  }).named('contactSales');

const INPUT = { email: 'buyer@example.test' };

const server = (target: ReturnType<typeof limited>) =>
  httpServer({
    routes: [toRoute(target)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const post = (app: ReturnType<typeof server>): Promise<Response> =>
  app.fetch(
    new Request('http://dev.test/api/sales/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(INPUT),
    }),
  );

/** The error code an attempt ended with, or `'ok'`. */
const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

const anonymous = (): Ctx => ctxOf({});

describe('a declared rate limit is refused after the limit on every surface', () => {
  test('HTTP: 200, 200, 429 — with the declared numbers on the headers', async () => {
    const app = server(limited());
    const responses: Response[] = [];
    for (let i = 0; i < 3; i += 1) responses.push(await post(app));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 429]);
    const [, , refused] = responses;
    if (refused === undefined) return expect.unreachable('three calls answer three responses');
    expect(refused.headers.get('ratelimit-limit')).toBe('2');
    expect(refused.headers.get('ratelimit-remaining')).toBe('0');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await refused.json()) as { code: string }).code).toBe('X_RATE_LIMITED');
  });

  test('HTTP: a 200 reports the action bucket, not the 120-burst default', async () => {
    const response = await post(server(limited()));
    expect(response.headers.get('ratelimit-limit')).toBe('2');
    expect(response.headers.get('ratelimit-remaining')).toBe('1');
  });

  // `surface: 'mcp'` is the call `@ultimat3/mcp`'s projection makes (`projectable.ts`): the one
  // tool path, a tier up, reaching this one `invoke`.
  test('MCP: the tool call is refused X_RATE_LIMITED on the third call', async () => {
    const target = limited();
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      seen.push(
        await runWithContext(anonymous(), () => outcome(invoke(target, INPUT, { surface: 'mcp' }))),
      );
    }
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });

  test('job: the queued run is refused X_RATE_LIMITED on the third call', async () => {
    const handle = limited().job();
    const ctx = ctxOf({ actor: userActor({ id: 'u-job' }) });
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) seen.push(await outcome(handle.invoke(INPUT, ctx)));
    expect(seen).toEqual(['ok', 'ok', 'X_RATE_LIMITED']);
  });

  test('the surfaces spend ONE bucket: one caller over MCP and a job leaves HTTP nothing', async () => {
    const target = limited();
    const caller = ctxOf({ actor: userActor({ id: 'u-shared' }) });
    expect(
      await runWithContext(caller, () => outcome(invoke(target, INPUT, { surface: 'mcp' }))),
    ).toBe('ok');
    expect(await outcome(target.job().invoke(INPUT, caller))).toBe('ok');
    expect(await outcome(target(INPUT, { ctx: caller, surface: 'http' }))).toBe('X_RATE_LIMITED');
  });

  // Decided: an anonymous caller with no address shares ONE bucket per population — every
  // unaddressed anonymous request, and separately every job run nobody attributed — rather than
  // none. Unlimited is the abuse; one bucket for both populations let a request flood park jobs.
  test('anonymous HTTP with no address and unattributed jobs are two buckets, not one', async () => {
    const target = limited();
    expect((await post(server(target))).status).toBe(200);
    expect((await post(server(target))).status).toBe(200);
    expect((await post(server(target))).status).toBe(429);
    expect(await outcome(target.job().invoke(INPUT, anonymous()))).toBe('ok');
  });
});

describe('a job run is charged to its tenant', () => {
  /** What `jobRunActor` hands a run: the worker's anonymous identity, carrying the job's org. */
  const runAs = (orgId: string): Ctx => ctxOf({ actor: { ...anonymousActor(), orgId } });

  test('two tenants’ runs spend two buckets, never one shared `ip:unknown`', async () => {
    const handle = limited().job();
    for (let i = 0; i < 2; i += 1)
      expect(await outcome(handle.invoke(INPUT, runAs('acme')))).toBe('ok');
    expect(await outcome(handle.invoke(INPUT, runAs('acme')))).toBe('X_RATE_LIMITED');
    expect(await outcome(handle.invoke(INPUT, runAs('beta')))).toBe('ok');
  });
});

describe('an idempotent replay is its stored answer, never a 429', () => {
  test('a replayed key spends nothing; a new key past the limit is refused', async () => {
    const once = action({
      input: t.object({ email: t.email }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      idempotent: true,
      rateLimit: { limit: 1, windowMs: 60_000 },
      handle: () => ({ ok: true }),
    }).named('chargeOnce');
    const ctx = ctxOf({ actor: userActor({ id: 'u-idem' }) });
    const call = (idempotencyKey: string) =>
      outcome(once(INPUT, { ctx, surface: 'http', idempotencyKey }));
    expect(await call('k1')).toBe('ok');
    expect(await call('k1')).toBe('ok');
    expect(await call('k2')).toBe('X_RATE_LIMITED');
  });
});

describe('a nested call inherits the address of the request that started it', () => {
  test('an anonymous visitor’s tool calls are keyed by that visitor, not shared', async () => {
    const tool = limited();
    // Stands in for `agent()`: an action whose handler calls another action with no address.
    const outer = action({
      input: t.object({ email: t.email }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: async ({ input }) => {
        await tool(input, { surface: 'mcp' });
        return { ok: true };
      },
    }).named('askAgent');
    const visit = (clientAddress: string) =>
      outcome(outer(INPUT, { ctx: anonymous(), surface: 'http', clientAddress }));
    expect([await visit('192.0.2.7'), await visit('192.0.2.7'), await visit('192.0.2.7')]).toEqual([
      'ok',
      'ok',
      'X_RATE_LIMITED',
    ]);
    // A second visitor is not refused for the first one's spend.
    expect(await visit('192.0.2.8')).toBe('ok');
  });
});

describe('the declared limit is the HTTP limit, not capped beneath it', () => {
  test('an action declaring more than `default` holds is not refused at `default`', async () => {
    const generous = action({
      input: t.object({ email: t.email }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      rateLimit: { limit: 4, windowMs: 60_000 },
      handle: () => ({ ok: true }),
    }).named('contactSales');
    // `default` holds two here — the stand-in for the shipped 120 an action may declare above.
    const app = httpServer({
      routes: [toRoute(generous)],
      config: defineHttpConfig({
        rateLimit: {
          scope: 'process',
          buckets: { default: { capacity: 2, refillPerSecond: 0.000_1 } },
        },
      }),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await post(app)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
  });
});

describe('whose bucket, and from which store', () => {
  test('the bucket is per caller: one actor spending it out leaves another untouched', async () => {
    const target = limited();
    const alice = ctxOf({ actor: userActor({ id: 'alice' }) });
    const bob = ctxOf({ actor: userActor({ id: 'bob' }) });
    for (let i = 0; i < 2; i += 1) await target.job().invoke(INPUT, alice);
    expect(await outcome(target.job().invoke(INPUT, alice))).toBe('X_RATE_LIMITED');
    expect(await outcome(target.job().invoke(INPUT, bob))).toBe('ok');
  });

  test('an anonymous caller is keyed by the address it came from', async () => {
    const target = limited();
    const from = (clientAddress: string) =>
      outcome(target(INPUT, { ctx: anonymous(), surface: 'mcp', clientAddress }));
    expect([await from('192.0.2.1'), await from('192.0.2.1'), await from('192.0.2.1')]).toEqual([
      'ok',
      'ok',
      'X_RATE_LIMITED',
    ]);
    expect(await from('192.0.2.2')).toBe('ok');
  });

  test('the installed store is the one spent — the instance the server was handed', async () => {
    const taken: string[] = [];
    const inner = memoryRateLimitStore();
    const store: RateLimitStore = {
      scope: inner.scope,
      take: (key, bucket, cost, nowMs) => {
        taken.push(key);
        return inner.take(key, bucket, cost, nowMs);
      },
      peek: (key, bucket, nowMs) => inner.peek(key, bucket, nowMs),
      reset: (key) => inner.reset(key),
    };
    installRateLimitStore(store);
    await limited()
      .job()
      .invoke(INPUT, ctxOf({ actor: userActor({ id: 'u9' }) }));
    expect(taken).toEqual(['action:contactSales|actor:u9']);
  });

  test('an in-process call (surface server) is app code, not a caller, and spends nothing', async () => {
    const target = limited();
    const ctx = anonymous();
    for (let i = 0; i < 5; i += 1) expect(await outcome(target(INPUT, { ctx }))).toBe('ok');
    expect(
      await runWithContext(ctx, () => outcome(invoke(target, INPUT, { surface: 'mcp' }))),
    ).toBe('ok');
  });
});

describe('a retry is not charged for a refusal', () => {
  test('a refused job attempt spends nothing: one refill admits exactly one retry', async () => {
    const target = limited();
    const clock = frozenClock('2026-10-04T00:00:00Z');
    const ctx = ctxOf({ actor: userActor({ id: 'u-retry' }), clock });
    for (let i = 0; i < 2; i += 1) await target.job().invoke(INPUT, ctx);
    // Three refused retries in a row: had any of them spent, the refill below would not cover it.
    for (let i = 0; i < 3; i += 1) {
      expect(await outcome(target.job().invoke(INPUT, ctx))).toBe('X_RATE_LIMITED');
    }
    clock.advance(30_000); // one token back at 2 per 60s
    expect(await outcome(target.job().invoke(INPUT, ctx))).toBe('ok');
    expect(await outcome(target.job().invoke(INPUT, ctx))).toBe('X_RATE_LIMITED');
  });
});
