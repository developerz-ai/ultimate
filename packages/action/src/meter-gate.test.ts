// The meter's two call-time halves: a limit resolved from the caller's context (the tenant's plan,
// read by the app) and checked, and a crossed `warnAt` enqueued once per tenant per period — after
// the draw landed, outside the caller's transaction, and never at the cost of the call.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { resetMeterStore } from './adapter';
import type { MeterWarnEnqueueOptions, MeterWarning, ResolvedLimit } from './meter';
import { meterSubject } from './meter-gate';
import { withCallerAddress, withJobFrame } from './rate-limit-gate';

beforeEach(() => resetMeterStore());
afterEach(() => resetMeterStore());

const NOW = '2026-11-06T09:30:00.000Z';
const PLANS = new Map([
  ['org-free', 2],
  ['org-team', 4],
]);

const caller = (orgId: string, clock = frozenClock(NOW)): Ctx =>
  ctxOf({ actor: userActor({ id: `u-${orgId}`, orgId }), clock });

interface Sent {
  readonly warning: MeterWarning;
  readonly options: MeterWarnEnqueueOptions;
}

const warnings = (fail = 0) => {
  const sent: Sent[] = [];
  let failures = fail;
  return {
    sent,
    enqueue: async (warning: MeterWarning, options: MeterWarnEnqueueOptions) => {
      if (failures > 0) {
        failures -= 1;
        return Promise.reject(new Error('the queue is down'));
      }
      sent.push({ warning, options });
      return { runId: 'r1' };
    },
  };
};

const declared = (limit: ResolvedLimit, onWarn?: ReturnType<typeof warnings>) =>
  action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    meter: {
      name: 'exports',
      period: 'day',
      limit,
      ...(onWarn === undefined ? {} : { warnAt: 0.5, onWarn }),
    },
    handle: () => ({ ok: true }),
  }).named('exportReport');

const outcome = (attempt: Promise<unknown>): Promise<string> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => (error as { readonly code?: string }).code ?? 'uncoded',
  );

const calls = async (target: ReturnType<typeof declared>, ctx: Ctx, n: number) => {
  const seen: string[] = [];
  for (let i = 0; i < n; i += 1) seen.push(await outcome(target({}, { ctx })));
  return seen;
};

describe('a limit resolved per call', () => {
  test("each tenant is held to its own plan's number", async () => {
    const target = declared(({ ctx }) => PLANS.get(ctx.actor.orgId ?? '') ?? 0);
    expect(await calls(target, caller('org-free'), 3)).toEqual(['ok', 'ok', 'X_METER_EXCEEDED']);
    expect(await calls(target, caller('org-team'), 5)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'X_METER_EXCEEDED',
    ]);
    // No plan resolves to 0, which refuses — never to "unlimited".
    expect(await calls(target, caller('org-unknown'), 1)).toEqual(['X_METER_EXCEEDED']);
  });

  test('an async resolver is awaited', async () => {
    const target = declared(async () => 1);
    expect(await calls(target, caller('org-a'), 2)).toEqual(['ok', 'X_METER_EXCEEDED']);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, '5'])(
    'a resolver answering %p is X_METER_INVALID, never allow-all',
    async (bad) => {
      const target = declared(() => bad as number);
      expect(await calls(target, caller('org-a'), 1)).toEqual(['X_METER_INVALID']);
    },
  );
});

describe('a crossed warnAt', () => {
  test('enqueues once per tenant per period, after the crossing draw, outside the transaction', async () => {
    const sink = warnings();
    const clock = frozenClock(NOW);
    const target = declared(4, sink);
    await calls(target, caller('org-a', clock), 4);
    expect(sink.sent).toEqual([
      {
        warning: {
          action: 'exportReport',
          meter: 'exports',
          orgId: 'org-a',
          actorId: 'u-org-a',
          used: 2,
          limit: 4,
          periodStart: '2026-11-06T00:00:00.000Z',
          resetsAt: '2026-11-07T00:00:00.000Z',
        },
        options: { outbox: false, tenantId: 'org-a' },
      },
    ]);
    await calls(target, caller('org-b', clock), 2);
    expect(sink.sent.map((sent) => sent.warning.orgId)).toEqual(['org-a', 'org-b']);
    clock.advance(86_400_000);
    await calls(target, caller('org-a', clock), 2);
    expect(sink.sent).toHaveLength(3);
  });

  test('parallel crossings warn once', async () => {
    const sink = warnings();
    const target = declared(10, sink);
    const ctx = caller('org-a');
    await Promise.all(Array.from({ length: 10 }, () => outcome(target({}, { ctx }))));
    expect(sink.sent).toHaveLength(1);
  });

  test('a refused draw warns about nothing', async () => {
    const sink = warnings();
    await calls(declared(0, sink), caller('org-a'), 3);
    expect(sink.sent).toEqual([]);
  });

  test('an enqueue that fails never fails the call, and the next draw tries again', async () => {
    const sink = warnings(1);
    const target = declared(4, sink);
    expect(await calls(target, caller('org-a'), 3)).toEqual(['ok', 'ok', 'ok']);
    expect(sink.sent.map((sent) => sent.warning.used)).toEqual([3]);
  });
});

describe('meterSubject', () => {
  test('the tenant, else the signed-in actor, else one anonymous counter', () => {
    expect(meterSubject(caller('org-a'))).toBe('org:org-a');
    expect(meterSubject(ctxOf({ actor: userActor({ id: 'u1' }) }))).toBe('actor:u1');
    expect(meterSubject(ctxOf({}))).toBe('anonymous');
  });

  // The rate limiter's population split: anonymous web traffic spending the shared counter must
  // not refuse a tenantless job run until the period ends, nor the reverse.
  test('a tenantless job run counts apart from anonymous visitors, as the rate limiter does', () => {
    expect(withJobFrame(() => meterSubject(ctxOf({})))).toBe('job:unattributed');
    expect(withCallerAddress('203.0.113.9', () => meterSubject(ctxOf({})))).toBe('anonymous');
    expect(withJobFrame(() => meterSubject(caller('org-a')))).toBe('org:org-a');
  });
});
