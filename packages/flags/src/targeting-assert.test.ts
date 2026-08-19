// Declaration-time refusals. Every case here is reachable from `applyFlagSnapshot`, which lands a
// payload no type ever checked — so the failures pinned are the ones that read as wired and decide
// something other than what they say.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { FlagTargeting } from './targeting';
import { evaluateTargeting } from './targeting';
import { assertTargeting } from './targeting-assert';

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

/** A snapshot payload, i.e. a value that reached this package with no type in front of it. */
const snapshot = (value: unknown): FlagTargeting => value as FlagTargeting;

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

  test('refuses a subjects entry naming a built-in kind — orgs and actors are the one spelling', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: false, subjects: { org: ['org-a'] } })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() => assertTargeting('a.flag', { default: false, subjects: { actor: ['user-1'] } })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses subject ids a store snapshot can carry but nothing can match', () => {
    expect(
      caught(() =>
        assertTargeting('a.flag', snapshot({ default: false, subjects: { '': ['x'] } })),
      ),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() =>
        assertTargeting('a.flag', snapshot({ default: false, subjects: { bank: 'bbva' } })),
      ),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() =>
        assertTargeting('a.flag', snapshot({ default: false, subjects: { bank: [''] } })),
      ),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses a blank bucketBy, which would name no kind at all', () => {
    expect(
      caught(() =>
        assertTargeting('a.flag', snapshot({ default: false, rollout: 10, bucketBy: '  ' })),
      ),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses a bucketBy with no rollout — it divides nothing', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: false, bucketBy: 'org' })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('accepts an app-declared bucketBy kind — the kind space is open, like a flag key', () => {
    // There is no registry of kinds to check against, deliberately: a typo raises
    // X_FLAG_SUBJECT_REQUIRED at the first evaluation, the same loud failure an undeclared flag
    // key already gets from X_FLAG_UNKNOWN. A second declaration surface would buy little.
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: 10, bucketBy: 'bank' })),
    ).toBeUndefined();
  });

  test('accepts the shapes a real declaration uses', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: false, orgs: ['org-a'] })),
    ).toBeUndefined();
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: 10, bucketBy: 'org' })),
    ).toBeUndefined();
    expect(
      caught(() =>
        assertTargeting('a.flag', {
          default: false,
          subjects: { bank: ['bank_integration:bbva'] },
        }),
      ),
    ).toBeUndefined();
    expect(caught(() => assertTargeting('a.flag', { default: true }))).toBeUndefined();
    expect(
      caught(() => assertTargeting('a.flag', { default: false, rollout: 25 })),
    ).toBeUndefined();
    expect(
      caught(() => assertTargeting('a.flag', { default: false, actors: ['x'], roles: ['admin'] })),
    ).toBeUndefined();
  });
});

// F4. `assertTargeting` used to destructure its argument before establishing there was one.
describe('unit · assertTargeting refuses a targeting that is not an object', () => {
  test('null is a coded refusal, not a bare TypeError out of a destructure', () => {
    const thrown = caught(() => assertTargeting('billing.new', snapshot(null)));
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(thrown).not.toBeInstanceOf(TypeError);
  });

  test('a bare string is refused rather than accepted as a targeting with no fields', () => {
    // `{ 'billing.new': 'off' }` used to pass every check — `default`, `actors`, `rollout` and
    // `subjects` are all `undefined` on a string — and then answer `undefined` per evaluation.
    expect(caught(() => assertTargeting('billing.new', snapshot('off')))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    expect(caught(() => assertTargeting('billing.new', snapshot(7)))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    expect(caught(() => assertTargeting('billing.new', snapshot(undefined)))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
  });

  test('an array is not a targeting either — its fields are all undefined too', () => {
    expect(caught(() => assertTargeting('billing.new', snapshot([])))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
  });
});

// F2. `default` is the one required field, and it was the one field with no shape check.
describe('unit · assertTargeting refuses a default that is not a boolean', () => {
  test('a missing default is refused where it is declared, not answered as undefined', () => {
    // `isEnabled` returns `boolean`. With no default, `evaluateTargeting` returned `undefined`
    // through that type, so every `=== false` call site silently changed meaning.
    expect(caught(() => assertTargeting('billing.new', snapshot({})))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
  });

  test("a truthy non-boolean is refused — 'yes' is not on", () => {
    expect(
      caught(() => assertTargeting('billing.new', snapshot({ default: 'yes' }))),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() => assertTargeting('billing.new', snapshot({ default: 1 }))),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() => assertTargeting('billing.new', snapshot({ default: null }))),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });
});

// F1 / F3. `subjects` was checked with `Array.isArray`; the three flat lists were not, and a
// string has `.includes` — which matches by SUBSTRING.
describe('unit · assertTargeting refuses a flat allow list that is not a list', () => {
  for (const field of ['actors', 'roles', 'orgs'] as const) {
    test(`${field} as a bare string is refused, because a string matches by substring`, () => {
      expect(
        caught(() =>
          assertTargeting('billing.new', snapshot({ default: false, [field]: 'user_100' })),
        ),
      ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    });

    test(`${field} holding something that is not an id is refused`, () => {
      expect(
        caught(() => assertTargeting('billing.new', snapshot({ default: false, [field]: [''] }))),
      ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
      expect(
        caught(() => assertTargeting('billing.new', snapshot({ default: false, [field]: [42] }))),
      ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    });
  }

  test('the refusal is what stops a substring match answering true for a stranger', () => {
    // The whole point, spelled out: without the guard `actors: 'user_100'` answers true for
    // `user_1`, `user_10`, `ser_10` and `u` — every substring of the operator's one id.
    const bad = snapshot({ default: false, actors: 'user_100' });
    expect(caught(() => assertTargeting('billing.new', bad))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    for (const id of ['user_1', 'user_10', 'ser_10', 'u']) {
      expect(evaluateTargeting('billing.new', bad, userActor({ id }))).toBe(true);
    }
  });

  test('a non-array roles throws a CODED refusal, never a TypeError from inside isEnabled', () => {
    // `roles` reached `.some()`, which a string does not have — a bare TypeError out of a policy
    // predicate, on a path documented as pure and synchronous.
    const bad = snapshot({ default: false, roles: 'admin' });
    expect(caught(() => assertTargeting('billing.new', bad))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    expect(
      caught(() => evaluateTargeting('billing.new', bad, userActor({ id: 'u' }))),
    ).toBeInstanceOf(TypeError);
  });
});
