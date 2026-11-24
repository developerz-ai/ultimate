// The programmatic draw: an amount counted on the caller's counter only while it fits, idempotent
// under a key (a retry, a parallel duplicate, one just after the reset), on the counters a declared
// `meter:` of the same name uses, and refused with the call site in its fix when malformed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Ctx } from '@ultimat3/core';
import { ctxOf, frozenClock, userActor } from '@ultimat3/core';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { resetMeterStore } from './adapter';
import type { MeterDrawInput } from './meter-draw';
import { drawMeter } from './meter-draw';

beforeEach(() => resetMeterStore());
afterEach(() => resetMeterStore());

const NOW = '2026-11-06T23:59:58.000Z';
const HOUR = 3_600_000;

const caller = (orgId: string, clock = frozenClock(NOW)): Ctx =>
  ctxOf({ actor: userActor({ id: `u-${orgId}`, orgId }), clock });

const tokens = (amount: number, key: string, limit = 1000): MeterDrawInput => ({
  meter: 'tokens',
  period: 'day',
  amount,
  limit,
  key,
});

const codeOf = (attempt: Promise<unknown>): Promise<unknown> =>
  attempt.then(
    () => 'ok',
    (error: unknown) => error,
  );

describe('drawMeter', () => {
  test('counts the amount and answers the count, the limit and the reset', async () => {
    const ctx = caller('o1');
    expect(await drawMeter(ctx, tokens(300, 'run-1'))).toEqual({
      used: 300,
      limit: 1000,
      replayed: false,
      resetsAt: '2026-11-07T00:00:00.000Z',
    });
    expect((await drawMeter(ctx, tokens(450, 'run-2'))).used).toBe(750);
  });

  test('two draws with one key count once, in turn or in parallel', async () => {
    const ctx = caller('o1');
    await drawMeter(ctx, tokens(300, 'run-1'));
    expect(await drawMeter(ctx, tokens(300, 'run-1'))).toMatchObject({ used: 300, replayed: true });
    const racers = await Promise.all(
      Array.from({ length: 20 }, () => drawMeter(ctx, tokens(100, 'run-2'))),
    );
    expect(racers.filter((one) => !one.replayed)).toHaveLength(1);
    expect((await drawMeter(ctx, tokens(1, 'run-3'))).used).toBe(401);
  });

  test('an amount that would pass the limit counts nothing, and its key stays unspent', async () => {
    const ctx = caller('o1');
    await drawMeter(ctx, tokens(900, 'run-1'));
    const refused = await codeOf(drawMeter(ctx, tokens(101, 'run-2')));
    expect(refused).toMatchObject({
      code: 'X_METER_EXCEEDED',
      meta: { meter: 'tokens', limit: 1000, resetsAt: '2026-11-07T00:00:00.000Z' },
    });
    expect(String((refused as Error).message)).not.toContain('on action');
    expect((refused as { readonly fix: string }).fix).toContain('drawMeter(');
    // The remainder is still there, and the refused key is judged afresh on a raised limit.
    expect((await drawMeter(ctx, tokens(100, 'run-3'))).used).toBe(1000);
    expect(await drawMeter(ctx, tokens(101, 'run-2', 2000))).toMatchObject({
      used: 1101,
      replayed: false,
    });
  });

  test('a retry just after the reset still counts once; the period after forgets the key', async () => {
    const clock = frozenClock(NOW);
    const ctx = caller('o1', clock);
    await drawMeter(ctx, tokens(500, 'run-1'));
    clock.advance(5_000);
    expect(await drawMeter(ctx, tokens(500, 'run-1'))).toMatchObject({ used: 0, replayed: true });
    expect((await drawMeter(ctx, tokens(10, 'run-2'))).used).toBe(10);
    clock.advance(24 * HOUR);
    expect(await drawMeter(ctx, tokens(500, 'run-1'))).toMatchObject({
      used: 500,
      replayed: false,
    });
  });

  test("a replay answers even when the period's allowance is spent", async () => {
    const ctx = caller('o1');
    await drawMeter(ctx, tokens(1000, 'run-1'));
    expect(await drawMeter(ctx, tokens(1000, 'run-1'))).toMatchObject({
      used: 1000,
      replayed: true,
    });
  });

  test('each tenant counts on its own counter, against its own resolved limit', async () => {
    const plan = ({ ctx }: { readonly ctx: Ctx }) => (ctx.actor.orgId === 'o-team' ? 50 : 5);
    const draw = (orgId: string, key: string) =>
      codeOf(drawMeter(caller(orgId), { ...tokens(6, key), limit: plan }));
    expect(await draw('o-free', 'a')).toMatchObject({ code: 'X_METER_EXCEEDED' });
    expect(await draw('o-team', 'a')).toBe('ok');
  });

  test('shares the counter of a declared meter with the same name and period', async () => {
    const ctx = caller('o1');
    const call = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      meter: { name: 'tokens', period: 'day', limit: 1000 },
      handle: () => ({ ok: true }),
    }).named('chat');
    await call({}, { ctx });
    expect((await drawMeter(ctx, tokens(999, 'run-1'))).used).toBe(1000);
    expect(await codeOf(call({}, { ctx }))).toMatchObject({ code: 'X_METER_EXCEEDED' });
  });

  test('a malformed draw is X_METER_INVALID, its fix naming the drawMeter call', async () => {
    const ctx = caller('o1');
    const cases: readonly MeterDrawInput[] = [
      tokens(0, 'k'),
      tokens(1.5, 'k'),
      tokens(1, ''),
      tokens(1, 'k'.repeat(256)),
      { ...tokens(1, 'k'), meter: 'not a name' },
      { ...tokens(1, 'k'), period: 'week' as MeterDrawInput['period'] },
      { ...tokens(1, 'k'), limit: () => -1 },
    ];
    for (const input of cases) {
      const error = await codeOf(drawMeter(ctx, input));
      expect(error).toMatchObject({ code: 'X_METER_INVALID' });
      expect((error as { readonly fix: string }).fix).toContain('edit the drawMeter call');
    }
  });
});
