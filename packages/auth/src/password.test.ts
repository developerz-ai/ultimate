import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { configureKdfGate, resetKdfGate } from './kdf-gate';
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

/**
 * `Bun.password.verify` THROWS on a stored hash it cannot parse — measured, bun 1.3.14:
 * `UnsupportedAlgorithm` for a Django pbkdf2 row, `InvalidEncoding` for a truncated bcrypt one.
 * A throw on exactly the rows that have not migrated off the legacy scheme is an
 * account-enumeration oracle, on the one table where a foreign hash is the normal state.
 */
describe('a stored hash Bun cannot read', () => {
  const UNREADABLE = [
    'pbkdf2_sha256$600000$abc$deadbeef', // Django's default, the commonest import
    '$2a$12$abcdefghijklmnopqrstuv', // bcrypt, truncated mid-salt
    '', // an account with no password credential at all
    '$argon2id$v=19$m=19456,t=2', // our own PHC string, cut before the hash
  ] as const;

  for (const hash of UNREADABLE) {
    test(`answers the one generic failure for ${JSON.stringify(hash)}`, async () => {
      const result = await verifyPassword({ hash, password: PASSWORD, params: LEGACY_PARAMS });
      expect(result).toEqual({ ok: false, needsRehash: false });
    });
  }

  test('is indistinguishable from a wrong password and from an unknown user', async () => {
    const good = await hashPassword(PASSWORD, LEGACY_PARAMS);
    const wrongPassword = await verifyPassword({ hash: good, password: 'not-the-password-1234' });
    const unknownUser = await verifyPassword({ hash: null, password: 'not-the-password-1234' });
    for (const hash of UNREADABLE) {
      const foreign = await verifyPassword({ hash, password: 'not-the-password-1234' });
      expect(foreign).toEqual(wrongPassword);
      expect(foreign).toEqual(unknownUser);
    }
  });

  /**
   * A zero-width gate refuses every KDF, so this asserts the unreadable path runs the same work
   * the other two do rather than answering for free — the timing half of the same oracle, and the
   * only way to see it without a stopwatch.
   */
  test('burns the KDF the other two failures burn', async () => {
    configureKdfGate({ maxConcurrent: 0, maxQueued: 0 });
    try {
      const shed = async (hash: string | null): Promise<string> =>
        await verifyPassword({ hash, password: PASSWORD }).then(
          () => 'answered',
          (error: unknown) => (error instanceof UltimateError ? error.code : 'other'),
        );
      expect(await shed(null)).toBe('X_OVERLOADED');
      for (const hash of UNREADABLE) expect(await shed(hash)).toBe('X_OVERLOADED');
    } finally {
      resetKdfGate();
    }
  });
});

/**
 * The rehash-on-login lever a legacy migration depends on: bcrypt verifies natively through Bun,
 * so the first correct sign-in rewrites the row as argon2id. Fixing the unsupported case must not
 * fold this one in with it — supported-but-old is a verdict, unreadable is a failure.
 */
test('a bcrypt hash still verifies and still asks for a rehash', async () => {
  const bcrypt = await Bun.password.hash(PASSWORD, { algorithm: 'bcrypt', cost: 4 });
  expect(bcrypt.startsWith('$2')).toBe(true);
  expect(await verifyPassword({ hash: bcrypt, password: PASSWORD })).toEqual({
    ok: true,
    needsRehash: true,
  });
  expect(await verifyPassword({ hash: bcrypt, password: `${PASSWORD}!` })).toEqual({
    ok: false,
    needsRehash: false,
  });
});
