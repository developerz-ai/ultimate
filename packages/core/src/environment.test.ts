import { describe, expect, test } from 'bun:test';
import {
  ENVIRONMENT_KEY,
  isEnvironment,
  isLocal,
  isProduction,
  resolveEnvironment,
  tryResolveEnvironment,
} from './environment';
import { isUltimateError, type UltimateError } from './errors';

describe('resolveEnvironment', () => {
  test('ULTIMATE_ENV wins over NODE_ENV', () => {
    expect(resolveEnvironment({ env: { ULTIMATE_ENV: 'staging', NODE_ENV: 'production' } })).toBe(
      'staging',
    );
  });

  test('falls back to NODE_ENV, then to development', () => {
    expect(resolveEnvironment({ env: { NODE_ENV: 'production' } })).toBe('production');
    expect(resolveEnvironment({ env: {} })).toBe('development');
    expect(resolveEnvironment({ env: { ULTIMATE_ENV: '' } })).toBe('development');
  });

  test('a typo in our own key throws with the allowed values', () => {
    let caught: unknown;
    try {
      resolveEnvironment({ env: { ULTIMATE_ENV: 'prod' } });
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_ENVIRONMENT_INVALID');
    expect(error.cause).toContain('ULTIMATE_ENV="prod"');
    expect(error.fix).toContain('production');
  });

  test('an unknown NODE_ENV does not throw — it is not our key to police', () => {
    expect(resolveEnvironment({ env: { NODE_ENV: 'ci' } })).toBe('development');
  });

  test('production is exact, and staging is not local', () => {
    expect(isProduction({ env: { ULTIMATE_ENV: 'production' } })).toBe(true);
    expect(isProduction({ env: { ULTIMATE_ENV: 'staging' } })).toBe(false);
    expect(isLocal({ env: { ULTIMATE_ENV: 'staging' } })).toBe(false);
    expect(isLocal({ env: { ULTIMATE_ENV: 'development' } })).toBe(true);
    expect(isLocal({ env: { NODE_ENV: 'test' } })).toBe(true);
  });

  test('tryResolveEnvironment answers identically wherever resolveEnvironment answers', () => {
    for (const env of [
      { ULTIMATE_ENV: 'staging', NODE_ENV: 'production' },
      { NODE_ENV: 'production' },
      { NODE_ENV: 'ci' },
      { ULTIMATE_ENV: '' },
      {},
    ]) {
      expect(tryResolveEnvironment({ env })).toBe(resolveEnvironment({ env }));
    }
    expect(tryResolveEnvironment({ env: {}, fallback: 'staging' })).toBe('staging');
  });

  test('tryResolveEnvironment reports a typo as undefined instead of throwing', () => {
    expect(tryResolveEnvironment({ env: { ULTIMATE_ENV: 'prod' } })).toBeUndefined();
    // NODE_ENV is nobody's key to police, so an unknown one is not the undefined case.
    expect(tryResolveEnvironment({ env: { ULTIMATE_ENV: 'prod', NODE_ENV: 'production' } })).toBe(
      undefined,
    );
  });

  test('the key has exactly one spelling', () => {
    expect(ENVIRONMENT_KEY).toBe('ULTIMATE_ENV');
    expect(isEnvironment('staging')).toBe(true);
    expect(isEnvironment('prod')).toBe(false);
  });
});
