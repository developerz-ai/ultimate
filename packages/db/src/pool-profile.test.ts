// The per-role pool table, read by a role that arrives untyped from a JS caller.

import { describe, expect, test } from 'bun:test';
import type { Role } from '@ultimat3/core';
import { POOL_PROFILES, poolProfileFor } from './pool-profile';

describe('poolProfileFor', () => {
  test('answers each role its own profile', () => {
    expect(poolProfileFor('worker')).toBe(POOL_PROFILES.worker);
  });

  test('refuses a prototype member rather than answering the Object function as a pool', () => {
    // `POOL_PROFILES['constructor']` is `Object` — a "profile" with no `max`, which a pool would
    // open with no ceiling at all.
    for (const role of ['constructor', 'toString', '__proto__']) {
      expect(() => poolProfileFor(role as Role)).toThrow('X_ROLE_INVALID');
    }
  });
});
