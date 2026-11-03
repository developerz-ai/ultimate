// Single responsibility: `DATABASE_POOLER` as it reaches a process, and the idle-in-transaction
// number each role runs on. Numbers a fleet is sized around, so a changed one is a visible edit.

import { describe, expect, test } from 'bun:test';
import { POOL_PROFILES } from './pool-profile';
import { POOLER_ENV, poolerFromEnv } from './pooler';

describe('poolerFromEnv', () => {
  test.each(['session', 'transaction'] as const)('%s is that mode', (mode) => {
    expect(poolerFromEnv({ [POOLER_ENV]: mode })).toBe(mode);
  });

  test('unset and blank are no pooler', () => {
    expect(poolerFromEnv({})).toBeUndefined();
    expect(poolerFromEnv({ [POOLER_ENV]: '' })).toBeUndefined();
    expect(poolerFromEnv({ [POOLER_ENV]: '  ' })).toBeUndefined();
  });

  test.each(['statement', 'TRANSACTION', 'on'])('%s refuses, naming the two it could be', (raw) => {
    expect(() => poolerFromEnv({ [POOLER_ENV]: raw })).toThrow('X_ENV_MISSING');
    expect(() => poolerFromEnv({ [POOLER_ENV]: raw })).toThrow('not session or transaction');
  });
});

describe('POOL_PROFILES.idleInTransactionMs', () => {
  test('each role, with the two run-once roles unbounded', () => {
    expect(
      Object.fromEntries(
        Object.entries(POOL_PROFILES).map(([role, profile]) => [role, profile.idleInTransactionMs]),
      ),
    ).toEqual({
      web: 30_000,
      sync: 30_000,
      worker: 120_000,
      scheduler: 120_000,
      migrate: 0,
      replicator: 0,
    });
  });
});
