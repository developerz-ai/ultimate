import { describe, expect, test } from 'bun:test';
import {
  checkPasswordStrength,
  DEFAULT_PASSWORD_PARAMS,
  hashPassword,
  needsRehash,
  type PasswordParams,
  parseHashParams,
  verifyPassword,
} from './password';

// Deliberately below the current policy, so `needsRehash` has something to detect.
const LEGACY_PARAMS: PasswordParams = { algorithm: 'argon2id', memoryCost: 8192, timeCost: 1 };

const PASSWORD = 'correct-horse-battery-staple-42';

describe('password', () => {
  test('hash and verify round trip', async () => {
    const hash = await hashPassword(PASSWORD, LEGACY_PARAMS);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    const result = await verifyPassword({ hash, password: PASSWORD, params: LEGACY_PARAMS });
    expect(result.ok).toBe(true);
  });

  test('a wrong password fails', async () => {
    const hash = await hashPassword(PASSWORD, LEGACY_PARAMS);
    const result = await verifyPassword({ hash, password: `${PASSWORD}!`, params: LEGACY_PARAMS });
    expect(result.ok).toBe(false);
  });

  test('a hash written with weaker parameters is flagged for rehash', async () => {
    const legacyHash = await hashPassword(PASSWORD, LEGACY_PARAMS);
    expect(parseHashParams(legacyHash)).toEqual(LEGACY_PARAMS);
    expect(needsRehash(legacyHash, DEFAULT_PASSWORD_PARAMS)).toBe(true);

    const verified = await verifyPassword({
      hash: legacyHash,
      password: PASSWORD,
      params: DEFAULT_PASSWORD_PARAMS,
    });
    expect(verified).toEqual({ ok: true, needsRehash: true });
  });

  test('a hash written with the current parameters is not flagged', async () => {
    const currentHash = await hashPassword(PASSWORD, LEGACY_PARAMS);
    // Same parameters in and out: nothing to upgrade.
    expect(needsRehash(currentHash, LEGACY_PARAMS)).toBe(false);
    const verified = await verifyPassword({
      hash: currentHash,
      password: PASSWORD,
      params: LEGACY_PARAMS,
    });
    expect(verified).toEqual({ ok: true, needsRehash: false });
  });

  test('an unknown user runs the KDF and fails identically to a wrong password', async () => {
    const hash = await hashPassword(PASSWORD, LEGACY_PARAMS);
    const wrongPassword = await verifyPassword({
      hash,
      password: 'not-the-password-1234',
      params: LEGACY_PARAMS,
    });
    const unknownUser = await verifyPassword({
      hash: null,
      password: 'not-the-password-1234',
      params: LEGACY_PARAMS,
    });
    // Indistinguishable to the caller: same object, no "user not found" channel.
    expect(unknownUser).toEqual(wrongPassword);
    expect(unknownUser).toEqual({ ok: false, needsRehash: false });
  });

  test('strength check rejects short and common passwords with X_PASSWORD_WEAK', () => {
    expect(() => checkPasswordStrength('short')).toThrow('X_PASSWORD_WEAK');
    expect(() => checkPasswordStrength('password123')).toThrow('X_PASSWORD_WEAK');
    expect(() => checkPasswordStrength('aaaaaaaaaaaaaaaa')).toThrow('X_PASSWORD_WEAK');
    expect(() => checkPasswordStrength(PASSWORD)).not.toThrow();
  });
});
