// Precedence is the contract: an operator who names an actor must not be overruled by a hash.
// The declaration-time rules are here too, because a targeting that means "nobody" while reading
// like "half" is the silent wrong answer this package is meant to design out.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import { assertTargeting, evaluateTargeting } from './targeting';

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

/** An id the 1% rollout below definitely does not select — the precedence tests need one. */
const outsider = userActor({ id: 'user-7', roles: ['support'] });

describe('unit · precedence', () => {
  test('an allow-listed actor beats a rollout that excludes them', () => {
    expect(evaluateTargeting('a.flag', { default: false, rollout: 1 }, outsider)).toBe(false);
    expect(
      evaluateTargeting('a.flag', { default: false, rollout: 1, actors: ['user-7'] }, outsider),
    ).toBe(true);
  });

  test('an allow-listed role beats a rollout that excludes them', () => {
    expect(
      evaluateTargeting('a.flag', { default: false, rollout: 1, roles: ['support'] }, outsider),
    ).toBe(true);
  });

  test('a role nobody holds does not rescue an excluded actor', () => {
    expect(
      evaluateTargeting('a.flag', { default: false, rollout: 1, roles: ['admin'] }, outsider),
    ).toBe(false);
  });

  test('off and on are the declared default, with no rollout in play', () => {
    expect(evaluateTargeting('a.flag', { default: false }, outsider)).toBe(false);
    expect(evaluateTargeting('a.flag', { default: true }, outsider)).toBe(true);
  });

  test('a null actor gets the default — there is no id to hash and no re-rolling', () => {
    expect(evaluateTargeting('a.flag', { default: true, actors: ['user-7'] }, null)).toBe(true);
    expect(evaluateTargeting('a.flag', { default: false, rollout: 100 }, null)).toBe(false);
  });

  test('rollout 0 selects nobody and rollout 100 selects everybody', () => {
    expect(evaluateTargeting('a.flag', { default: false, rollout: 0 }, outsider)).toBe(false);
    expect(evaluateTargeting('a.flag', { default: false, rollout: 100 }, outsider)).toBe(true);
  });

  test('the same actor gets the same answer on every call', () => {
    const first = evaluateTargeting('a.flag', { default: false, rollout: 50 }, outsider);
    for (let call = 0; call < 500; call += 1) {
      expect(evaluateTargeting('a.flag', { default: false, rollout: 50 }, outsider)).toBe(first);
    }
  });
});

describe('unit · assertTargeting', () => {
  test('refuses a fractional rollout, which reads as half and means nobody', () => {
    const thrown = caught(() => {
      assertTargeting('a.flag', { default: false, rollout: 0.5 });
    });
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses a rollout outside 0-100', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: -1 })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: 101 })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses default:true beside a rollout — the two answer the same actors', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: true, rollout: 10 })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('accepts the shapes a real declaration uses', () => {
    expect(caught(() => assertTargeting('a.flag', { default: true }))).toBeUndefined();
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: 25 })),
    ).toBeUndefined();
    expect(
      caught(() => assertTargeting('a.flag', { default: false, actors: ['x'], roles: ['admin'] })),
    ).toBeUndefined();
  });
});
