// The sign-in state seal: what it opens, and the one number bounding it — screened at the reader,
// because a NaN deadline turns `now - issuedAt > ttlMs` false for every state ever sealed.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import { openIdentityState, sealIdentityState } from './identity-provider-cookie';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const seal = { secret: 'a'.repeat(32), clock: frozenClock(NOW) };
const yearLater = { ...seal, clock: frozenClock(new Date(NOW.getTime() + 365 * 86_400_000)) };

const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isUltimateError(error) ? error.code : 'not-an-UltimateError';
  }
  return 'did-not-throw';
};

describe('openIdentityState ttlMs', () => {
  const sealed = sealIdentityState('github', 'the-state', seal);

  test('a sealed state opens within its deadline and not after it', () => {
    expect(openIdentityState(sealed, 'github', { ...seal, ttlMs: 60_000 })).toBe('the-state');
    expect(codeOf(() => openIdentityState(sealed, 'github', yearLater))).toBe(
      'X_OAUTH_STATE_INVALID',
    );
  });

  test('a deadline that is not a whole positive number is refused, never compared', () => {
    for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      const code = codeOf(() => openIdentityState(sealed, 'github', { ...yearLater, ttlMs }));
      expect([ttlMs, code]).toEqual([ttlMs, 'X_CONFIG_INVALID']);
    }
  });
});
