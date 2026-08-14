// Direct coverage: the runtime role table — `isRole`, `resolveRole` and `ROLE_INFO`. This table
// feeds `x deploy` scaling defaults (per roles.ts's own header), so a value drifting silently
// would produce wrong deploy manifests.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { DEFAULT_ROLE, isRole, ROLE_INFO, ROLES, resolveRole } from './roles';

describe('isRole', () => {
  test('true for every member of ROLES', () => {
    for (const role of ROLES) {
      expect(isRole(role)).toBe(true);
    }
  });

  test('false for a non-string, empty string, unrelated string, undefined/null', () => {
    expect(isRole(42)).toBe(false);
    expect(isRole({})).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole('database')).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(null)).toBe(false);
  });
});

describe('resolveRole', () => {
  test('no env/key given at all falls back to DEFAULT_ROLE', () => {
    expect(resolveRole()).toBe(DEFAULT_ROLE);
  });

  test('ROLE unset in the given env → DEFAULT_ROLE', () => {
    expect(resolveRole({ env: {} })).toBe('web');
    expect(resolveRole({ env: {} })).toBe(DEFAULT_ROLE);
  });

  test('ROLE set to "" in the given env → DEFAULT_ROLE, same as unset', () => {
    expect(resolveRole({ env: { ROLE: '' } })).toBe(DEFAULT_ROLE);
  });

  test('unset ROLE with an explicit fallback returns the fallback, even a non-default role', () => {
    expect(resolveRole({ env: {}, fallback: 'worker' })).toBe('worker');
  });

  test('empty-string ROLE with an explicit fallback also returns the fallback', () => {
    expect(resolveRole({ env: { ROLE: '' }, fallback: 'scheduler' })).toBe('scheduler');
  });

  test('a valid ROLE value is returned exactly, for multiple distinct roles', () => {
    expect(resolveRole({ env: { ROLE: 'sync' } })).toBe('sync');
    expect(resolveRole({ env: { ROLE: 'migrate' } })).toBe('migrate');
    expect(resolveRole({ env: { ROLE: 'replicator' } })).toBe('replicator');
  });

  test('a valid ROLE ignores any fallback given — fallback only applies when unset', () => {
    expect(resolveRole({ env: { ROLE: 'sync' }, fallback: 'worker' })).toBe('sync');
  });

  test('an invalid ROLE value throws UltimateError X_ROLE_INVALID naming the bad value and the allowed list', () => {
    let caught: unknown;
    try {
      resolveRole({ env: { ROLE: 'bogus' } });
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_ROLE_INVALID');
    expect(typeof error.cause).toBe('string');
    expect(error.cause.length).toBeGreaterThan(0);
    expect(error.cause).toContain('bogus');
    expect(typeof error.fix).toBe('string');
    expect(error.fix.length).toBeGreaterThan(0);
    for (const role of ROLES) {
      expect(error.fix).toContain(role);
    }
  });

  test('a custom key option reads that env var name instead of ROLE', () => {
    expect(resolveRole({ env: { X_ROLE: 'worker', ROLE: 'sync' }, key: 'X_ROLE' })).toBe('worker');
    expect(resolveRole({ env: { X_ROLE: '' }, key: 'X_ROLE', fallback: 'sync' })).toBe('sync');
  });

  test('an invalid value under a custom key still throws X_ROLE_INVALID naming that key', () => {
    let caught: unknown;
    try {
      resolveRole({ env: { X_ROLE: 'nope' }, key: 'X_ROLE' });
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as UltimateError).code).toBe('X_ROLE_INVALID');
    expect((caught as UltimateError).cause).toContain('X_ROLE');
  });
});

describe('ROLE_INFO', () => {
  test('scheduler is a replica-capped, single-instance role', () => {
    expect(ROLE_INFO.scheduler).toEqual({
      role: 'scheduler',
      scalesOn: 'singleton',
      maxReplicas: 1,
      stateful: false,
    });
  });

  test('replicator is stateful and replica-capped', () => {
    expect(ROLE_INFO.replicator).toEqual({
      role: 'replicator',
      scalesOn: 'per-database',
      maxReplicas: 1,
      stateful: true,
    });
  });

  test('web scales on rps with no replica ceiling and is not stateful', () => {
    expect(ROLE_INFO.web).toEqual({
      role: 'web',
      scalesOn: 'rps',
      maxReplicas: null,
      stateful: false,
    });
  });

  test('every ROLE_INFO entry is keyed by its own role and covers all ROLES', () => {
    for (const role of ROLES) {
      expect(ROLE_INFO[role]?.role).toBe(role);
    }
    expect(Object.keys(ROLE_INFO).sort()).toEqual([...ROLES].sort());
  });
});
