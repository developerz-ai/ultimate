// Precedence is the contract: an operator who names an actor must not be overruled by a hash.
// The declaration-time rules are here too, because a targeting that means "nobody" while reading
// like "half" is the silent wrong answer this package is meant to design out.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import type { FlagTargeting } from './targeting';
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

/**
 * The tenant axis. The bug it removes is the one an actor-bucketed rollout creates: 3 of an org's
 * 30 members on the new path and 27 on the old, sharing documents, filing a bug nobody can
 * reproduce. Every assertion below is about a whole org landing on one side.
 */
describe('unit · the org axis', () => {
  const inA = userActor({ id: 'user-1', orgId: 'org-a' });
  const alsoInA = userActor({ id: 'user-2', orgId: 'org-a' });
  const inB = userActor({ id: 'user-3', orgId: 'org-b' });
  const orgless = userActor({ id: 'user-4' });

  test('an actor with no orgId throws rather than being answered off the actor axis', () => {
    expect(
      caught(() => evaluateTargeting('a.flag', { default: false, orgs: ['org-a'] }, orgless)),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('an org-bucketed rollout throws when the actor carries no orgId', () => {
    expect(
      caught(() =>
        evaluateTargeting('a.flag', { default: false, rollout: 50, bucketBy: 'org' }, orgless),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('an empty orgId is absent, not a tenant — it would hash to a real bucket', () => {
    expect(
      caught(() =>
        evaluateTargeting(
          'a.flag',
          { default: false, orgs: ['org-a'] },
          userActor({ id: 'user-5', orgId: '' }),
        ),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('an org allow list is on for every member of that org and off for another org', () => {
    const targeting: FlagTargeting = { default: false, orgs: ['org-a'] };
    expect(evaluateTargeting('a.flag', targeting, inA)).toBe(true);
    expect(evaluateTargeting('a.flag', targeting, alsoInA)).toBe(true);
    expect(evaluateTargeting('a.flag', targeting, inB)).toBe(false);
  });

  test('an allow-listed org beats a rollout that excludes it, like actors and roles do', () => {
    expect(evaluateTargeting('a.flag', { default: false, rollout: 0, orgs: ['org-a'] }, inA)).toBe(
      true,
    );
  });

  test('bucketBy org puts a whole org on one side of a 10% rollout', () => {
    // `org-12` buckets at 0 and `org-1` at 78 for this key — see the pins in bucket.test.ts.
    const targeting: FlagTargeting = { default: false, rollout: 10, bucketBy: 'org' };
    const members = (orgId: string): Actor[] =>
      Array.from({ length: 30 }, (_unused, index) =>
        userActor({ id: `member-${orgId}-${index}`, orgId }),
      );
    for (const member of members('org-12')) {
      expect(evaluateTargeting('billing.export', targeting, member)).toBe(true);
    }
    for (const member of members('org-1')) {
      expect(evaluateTargeting('billing.export', targeting, member)).toBe(false);
    }
  });

  test('the same (flag, org) buckets identically on every call', () => {
    const targeting: FlagTargeting = { default: false, rollout: 50, bucketBy: 'org' };
    const first = evaluateTargeting('billing.export', targeting, inA);
    for (let call = 0; call < 500; call += 1) {
      expect(evaluateTargeting('billing.export', targeting, alsoInA)).toBe(first);
    }
  });

  test('the default axis is still the actor, so a declared rollout is unchanged', () => {
    // `user-1` and `user-2` share an org and land on opposite sides — that is actor bucketing,
    // and it stays the default so no shipped flag changes answer.
    const targeting: FlagTargeting = { default: false, rollout: 60 };
    expect(evaluateTargeting('billing.export', targeting, inA)).toBe(true);
    expect(evaluateTargeting('billing.export', targeting, alsoInA)).toBe(false);
  });

  test('a null actor still gets the default — there is no context at all to be wrong about', () => {
    expect(evaluateTargeting('a.flag', { default: false, orgs: ['org-a'] }, null)).toBe(false);
    expect(
      evaluateTargeting('a.flag', { default: false, rollout: 100, bucketBy: 'org' }, null),
    ).toBe(false);
  });
});

/**
 * The general axis. Treasury's `flipper_id` is `"<kind>:<id>"` and its gates OR across whichever
 * records are in play — a workspace, a bank integration, a bank connection. `subjects` is that,
 * with `orgs` kept as the shorthand for the 90% case.
 */
describe('unit · arbitrary record subjects', () => {
  const actor = userActor({ id: 'user-1', orgId: 'org-a' });
  const bbva = { bank: 'bank_integration:bbva' };
  const santander = { bank: 'bank_integration:santander' };

  test('a record kind the evaluation context does not carry throws', () => {
    expect(
      caught(() =>
        evaluateTargeting(
          'a.flag',
          { default: false, subjects: { bank: ['bank_integration:bbva'] } },
          actor,
          undefined,
        ),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('an allow list on a record kind is on for that record and off for another', () => {
    const targeting: FlagTargeting = {
      default: false,
      subjects: { bank: ['bank_integration:bbva'] },
    };
    expect(evaluateTargeting('a.flag', targeting, actor, bbva)).toBe(true);
    expect(evaluateTargeting('a.flag', targeting, actor, santander)).toBe(false);
  });

  test('several record kinds are ORed, the way Flipper ORs the actors passed to one call', () => {
    const targeting: FlagTargeting = {
      default: false,
      subjects: { bank: ['bank_integration:bbva'], device: ['device-9'] },
    };
    expect(
      evaluateTargeting('a.flag', targeting, actor, {
        bank: 'bank_integration:x',
        device: 'device-9',
      }),
    ).toBe(true);
    expect(
      evaluateTargeting('a.flag', targeting, actor, {
        bank: 'bank_integration:bbva',
        device: 'device-1',
      }),
    ).toBe(true);
  });

  test('a missing kind throws even when an earlier kind already matched', () => {
    // Order independence. If the match short-circuited, whether this call answered `true` or
    // raised would depend on the order the keys happen to sit in the declaration — the same
    // input giving two different behaviours, which is worse than either one alone.
    const targeting: FlagTargeting = {
      default: false,
      subjects: { bank: ['bank_integration:bbva'], device: ['device-9'] },
    };
    expect(caught(() => evaluateTargeting('a.flag', targeting, actor, bbva))).toBeUltimateError(
      'X_FLAG_SUBJECT_REQUIRED',
    );
  });

  test('bucketBy a record kind puts a whole record on one side of a rollout', () => {
    // `bank_integration:bbva` buckets at 39 and `:santander` at 86 for this key — pinned below.
    const targeting: FlagTargeting = { default: false, rollout: 50, bucketBy: 'bank' };
    expect(evaluateTargeting('scraper.persist-profile', targeting, actor, bbva)).toBe(true);
    expect(evaluateTargeting('scraper.persist-profile', targeting, actor, santander)).toBe(false);
  });

  test('every actor on the same record lands on the same side, whoever is calling', () => {
    const targeting: FlagTargeting = { default: false, rollout: 50, bucketBy: 'bank' };
    for (let index = 0; index < 50; index += 1) {
      const caller = userActor({ id: `user-${index}`, orgId: `org-${index}` });
      expect(evaluateTargeting('scraper.persist-profile', targeting, caller, bbva)).toBe(true);
    }
  });

  test('bucketBy a record kind the context does not carry throws rather than bucketing the actor', () => {
    expect(
      caught(() =>
        evaluateTargeting(
          'a.flag',
          { default: false, rollout: 50, bucketBy: 'bank' },
          actor,
          undefined,
        ),
      ),
    ).toBeUltimateError('X_FLAG_SUBJECT_REQUIRED');
  });

  test('orgs is the same mechanism as subjects, spelled shorter', () => {
    const shorthand: FlagTargeting = { default: false, orgs: ['org-a'] };
    expect(evaluateTargeting('a.flag', shorthand, actor, undefined)).toBe(true);
    expect(
      evaluateTargeting(
        'a.flag',
        shorthand,
        userActor({ id: 'user-2', orgId: 'org-b' }),
        undefined,
      ),
    ).toBe(false);
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

  test('refuses a subjects entry naming a built-in kind — orgs and actors are the one spelling', () => {
    expect(
      caught(() => assertTargeting('a.flag', { default: false, subjects: { org: ['org-a'] } })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(
      caught(() => assertTargeting('a.flag', { default: false, subjects: { actor: ['user-1'] } })),
    ).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('refuses subject ids a store snapshot can carry but nothing can match', () => {
    const emptyKind: unknown = { default: false, subjects: { '': ['x'] } };
    expect(caught(() => assertTargeting('a.flag', emptyKind as FlagTargeting))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    const notAList: unknown = { default: false, subjects: { bank: 'bbva' } };
    expect(caught(() => assertTargeting('a.flag', notAList as FlagTargeting))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
    const emptyId: unknown = { default: false, subjects: { bank: [''] } };
    expect(caught(() => assertTargeting('a.flag', emptyId as FlagTargeting))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
  });

  test('refuses a blank bucketBy, which would name no kind at all', () => {
    const blank: unknown = { default: false, rollout: 10, bucketBy: '  ' };
    expect(caught(() => assertTargeting('a.flag', blank as FlagTargeting))).toBeUltimateError(
      'X_FLAG_TARGETING_INVALID',
    );
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
