// The registry's job is that a key resolves to exactly one flag, or to an error. Both halves are
// failure cases first: a duplicate key means one of two declarations decides nothing, and an
// unknown key answered `false` is a branch that silently never runs.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { allFlags, applyFlagSnapshot, defineFlag, hasFlag, resetFlags } from './registry';

const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (thrown) {
    return thrown;
  }
  return undefined;
};

const permanent = (key: string): void => {
  defineFlag({
    kind: 'permanent',
    key,
    description: `switch for ${key}`,
    targeting: { default: false },
  });
};

beforeEach(resetFlags);
afterEach(resetFlags);

describe('unit · defineFlag', () => {
  test('refuses a second declaration of the same key', () => {
    permanent('search.rerank');
    expect(caught(() => permanent('search.rerank'))).toBeUltimateError('X_FLAG_DUPLICATE');
  });

  test('returns the normalised flag, so a declaration is also a handle', () => {
    const flag = defineFlag({
      kind: 'temporary',
      key: 'checkout.new-tax-engine',
      description: 'scaffolding',
      owner: 'payments',
      expiresAt: '2026-01-01',
      targeting: { default: false },
    });
    expect(flag.key).toBe('checkout.new-tax-engine');
    expect(flag.kind).toBe('temporary');
    expect(hasFlag('checkout.new-tax-engine')).toBe(true);
  });
});

describe('unit · allFlags', () => {
  test('is sorted by key, so two reports diff cleanly', () => {
    permanent('z.last');
    permanent('a.first');
    permanent('m.middle');
    expect(allFlags().map((flag) => flag.key)).toEqual(['a.first', 'm.middle', 'z.last']);
  });
});

describe('unit · applyFlagSnapshot', () => {
  test('lands a store override on a declared flag without a second evaluation path', () => {
    permanent('search.rerank');
    const result = applyFlagSnapshot({ 'search.rerank': { default: false, rollout: 30 } });
    expect(result.applied).toEqual(['search.rerank']);
    expect(allFlags()[0]?.targeting.rollout).toBe(30);
  });

  test('reports a key this build does not declare instead of throwing the whole payload away', () => {
    permanent('search.rerank');
    const result = applyFlagSnapshot({
      'search.rerank': { default: true },
      'shipped.tomorrow': { default: true },
    });
    expect(result.applied).toEqual(['search.rerank']);
    expect(result.unknown).toEqual(['shipped.tomorrow']);
    expect(allFlags()[0]?.targeting.default).toBe(true);
  });

  test('refuses targeting that would silently mean nobody', () => {
    permanent('search.rerank');
    const thrown = caught(() =>
      applyFlagSnapshot({ 'search.rerank': { default: false, rollout: 0.3 } }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
  });

  test('a refused payload lands nothing — not the keys ahead of the bad one', () => {
    // The doc block says a bad targeting protects the fleet. It did not: the loop wrote each key
    // as it validated it, so `a.first` had already moved when `m.middle` threw, and the caller —
    // a poller or a realtime channel — sees only the throw and no record of the half that landed.
    permanent('a.first');
    permanent('m.middle');
    const thrown = caught(() =>
      applyFlagSnapshot({
        'a.first': { default: false, rollout: 10 },
        'm.middle': { default: false, rollout: 0.5 },
      }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(allFlags().map((flag) => flag.targeting.rollout)).toEqual([undefined, undefined]);
  });

  test('an unknown key ahead of a bad one still does not land the valid ones behind it', () => {
    permanent('a.first');
    permanent('z.last');
    const thrown = caught(() =>
      applyFlagSnapshot({
        'shipped.tomorrow': { default: true },
        'a.first': { default: false, rollout: 10 },
        'z.last': { default: false, rollout: 0.5 },
      }),
    );
    expect(thrown).toBeUltimateError('X_FLAG_TARGETING_INVALID');
    expect(allFlags()[0]?.targeting.rollout).toBe(undefined);
  });
});
