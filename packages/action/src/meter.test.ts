// A meter that could not be counted is refused at `action()`, where it is written — and the
// declaration is published as data: `describe()` and the OpenAPI operation, function and target
// stripped, the zone spelled out.

import { describe, expect, test } from 'bun:test';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ActionMeter } from './meter';

const target = { enqueue: async () => undefined };

const declare = (meter: ActionMeter) =>
  action({
    input: t.object({}),
    output: t.object({ ok: t.boolean }),
    policy: allow(),
    meter,
    handle: () => ({ ok: true }),
  });

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: unknown; meta?: { field?: unknown } }).meta?.field;
  }
  return 'accepted';
};

describe('assertMeterDeclaration, at action()', () => {
  test.each([
    ['name', { name: 'Calls Per Day', period: 'day', limit: 5 }],
    ['name', { name: 'x'.repeat(65), period: 'day', limit: 5 }],
    ['period', { name: 'calls', period: 'week', limit: 5 }],
    ['limit', { name: 'calls', period: 'day', limit: -1 }],
    ['limit', { name: 'calls', period: 'day', limit: Number.NaN }],
    ['limit', { name: 'calls', period: 'day', limit: 2.5 }],
    ['warnAt', { name: 'calls', period: 'day', limit: 5, warnAt: 0, onWarn: target }],
    ['warnAt', { name: 'calls', period: 'day', limit: 5, warnAt: 1.2, onWarn: target }],
    ['warnAt', { name: 'calls', period: 'day', limit: 5, warnAt: 0.8 }],
    ['warnAt', { name: 'calls', period: 'day', limit: 5, onWarn: target }],
  ])('refuses a bad %s with X_METER_INVALID', (field, meter) => {
    expect(codeOf(() => declare(meter as ActionMeter))).toBe(field);
  });

  // `String()` of a prototype-less object throws a TypeError, which reached the author instead.
  test('a name no string can be made of is still X_METER_INVALID, never a TypeError', () => {
    const name = Object.create(null) as string;
    expect(codeOf(() => declare({ name, period: 'day', limit: 5 }))).toBe('name');
  });

  test('accepts a fixed limit, a zero limit, a resolver and a full warn pair', () => {
    expect(codeOf(() => declare({ name: 'calls', period: 'month', limit: 0 }))).toBe('accepted');
    expect(
      codeOf(() =>
        declare({ name: 'ai.tokens', period: 'hour', limit: () => 9, warnAt: 1, onWarn: target }),
      ),
    ).toBe('accepted');
  });
});

describe('the meter as data', () => {
  test('describe() publishes the period, the UTC zone and a fixed limit; null for a resolver', () => {
    const fixed = declare({ name: 'calls', period: 'day', limit: 500 }).named('fixedMeter');
    expect(fixed.describe().meter).toEqual({
      name: 'calls',
      period: 'day',
      timeZone: 'UTC',
      limit: 500,
      warnAt: null,
    });
    const resolved = declare({
      name: 'calls',
      period: 'day',
      limit: () => 500,
      warnAt: 0.8,
      onWarn: target,
    }).named('resolvedMeter');
    expect(resolved.describe().meter).toMatchObject({ limit: null, warnAt: 0.8 });
    expect(resolved.openapi()['x-ultimate']).toMatchObject({
      meter: { name: 'calls', period: 'day', timeZone: 'UTC', limit: 'per-call' },
    });
  });

  test('an action with no meter keeps its operation without one', () => {
    const plain = action({
      input: t.object({}),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: () => ({ ok: true }),
    }).named('plainAction');
    expect(plain.describe().meter).toBeNull();
    expect(Object.hasOwn(plain.openapi()['x-ultimate'] as object, 'meter')).toBe(false);
  });
});
