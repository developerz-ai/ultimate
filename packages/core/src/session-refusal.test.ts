// The one list of codes that mean "this credential names no session". A miss here is the defect
// the realtime re-auth sweep had: a signed-out cookie read as an outage, and its socket kept.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from './errors';
import { isSessionRefusal, isSessionRefusalCode } from './session-refusal';

const coded = (code: string): UltimateError =>
  new UltimateError({ code, cause: 'a test refusal', fix: 'sign in again' });

describe('isSessionRefusal', () => {
  test.each(['X_UNAUTHENTICATED', 'X_SESSION_EXPIRED'])('%s is a refusal', (code) => {
    expect(isSessionRefusal(coded(code))).toBe(true);
    expect(isSessionRefusalCode(code)).toBe(true);
  });

  test('every other code is a failure, so a database blip disconnects nobody', () => {
    for (const code of ['X_DB_UNAVAILABLE', 'X_FORBIDDEN', 'X_OVERLOADED', 'X_API_KEY_INVALID']) {
      expect(isSessionRefusal(coded(code))).toBe(false);
      expect(isSessionRefusalCode(code)).toBe(false);
    }
  });

  test('only a coded error counts: a look-alike object or a string is never a refusal', () => {
    expect(isSessionRefusal({ code: 'X_UNAUTHENTICATED' })).toBe(false);
    expect(isSessionRefusal('X_UNAUTHENTICATED')).toBe(false);
    expect(isSessionRefusal(null)).toBe(false);
  });
});
