import { describe, expect, test } from 'bun:test';
import { defineAuth } from './auth';
import { mfaRequired } from './errors';
import { MemoryAdapter } from './memory-adapter';
import {
  base32Decode,
  base32Encode,
  createTotpReplayGuard,
  enrolTotp,
  generateRecoveryCodes,
  redeemRecoveryCode,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from './mfa';

const authWith = (issuer: string) => defineAuth({ adapter: new MemoryAdapter(), mfa: { issuer } });

// The secret every authenticator-app tutorial uses; keeps the vectors reproducible.
const SECRET = 'JBSWY3DPEHPK3PXP';
const AT = new Date(1_700_000_000_000);

describe('totp', () => {
  test('base32 round trips', () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255, 42, 17]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    // An unreadable secret fails closed rather than throwing into the login path.
    expect(base32Decode('not base32 !!!')).toHaveLength(0);
  });

  test('a code produces six digits and differs between steps', () => {
    const step = totpStep(AT);
    expect(totpCode(SECRET, step)).toMatch(/^\d{6}$/);
    expect(totpCode(SECRET, step)).not.toBe(totpCode(SECRET, step + 1));
  });

  test('the previous step verifies but three steps ago does not', () => {
    const step = totpStep(AT);
    const previous = verifyTotp({ secret: SECRET, code: totpCode(SECRET, step - 1), at: AT });
    expect(previous).toEqual({ ok: true, step: step - 1 });

    const stale = verifyTotp({ secret: SECRET, code: totpCode(SECRET, step - 3), at: AT });
    expect(stale).toEqual({ ok: false, step: null });
  });

  test('a step that was already spent is rejected as a replay', () => {
    const step = totpStep(AT);
    const guard = createTotpReplayGuard();
    const code = totpCode(SECRET, step);

    const first = verifyTotp({ secret: SECRET, code, at: AT });
    expect(first.ok).toBe(true);
    guard.remember('user-1', step, AT);

    const replay = verifyTotp({
      secret: SECRET,
      code,
      at: AT,
      usedSteps: new Set([step]),
    });
    expect(replay).toEqual({ ok: false, step });
    expect(guard.isUsed('user-1', step)).toBe(true);
    expect(guard.isUsed('user-2', step)).toBe(false);
  });

  test('enrolment produces an otpauth URI the app can scan', () => {
    const enrolment = enrolTotp(authWith('Ultimate'), {
      account: 'ada@example.test',
      secret: SECRET,
    });
    expect(enrolment.uri.startsWith('otpauth://totp/Ultimate:ada%40example.test?')).toBe(true);
    expect(enrolment.uri).toContain(`secret=${SECRET}`);
    expect(enrolment.uri).toContain('algorithm=SHA1');
    expect(enrolment.uri).toContain('period=30');
  });

  /**
   * `defineAuth({ mfa: { issuer } })` is documented as the product name the authenticator app
   * shows, and it reached no URI at all until `enrolTotp` was given the `auth` every other entry
   * point in this package already takes — the option was a string the framework wrote down and
   * never read.
   */
  test('the issuer in the URI is the one defineAuth declared', () => {
    const uri = enrolTotp(authWith('Postly'), { account: 'ada@example.test' }).uri;
    expect(uri.startsWith('otpauth://totp/Postly:ada%40example.test?')).toBe(true);
    expect(uri).toContain('issuer=Postly');
  });

  test('an explicit issuer overrides the declared one for the one call that names it', () => {
    const uri = enrolTotp(authWith('Postly'), {
      issuer: 'Postly Admin',
      account: 'ada@example.test',
    }).uri;
    expect(uri).toContain('issuer=Postly+Admin');
  });
});

/**
 * The table is bounded for the same reason every other in-memory table in the framework is
 * (`DEFAULT_MAX_AUTH_LIMIT_KEYS`, `DEFAULT_MAX_RATE_LIMIT_KEYS`, `DEFAULT_MAX_IDEMPOTENCY_KEYS`):
 * a per-subject map that only ever grows is one process' lifetime away from an OOM. Eviction is
 * the delicate half — dropping a subject makes their remembered steps replayable again — so the
 * order is asserted here, not just the bound.
 */
describe('the replay guard table', () => {
  test('a subject whose every step has left the drift window is forgotten', () => {
    const guard = createTotpReplayGuard();
    guard.remember('alice', totpStep(AT), AT);
    expect(guard.size).toBe(1);

    // Five minutes on: alice's step is far below the floor, so `verifyTotp` can never offer it
    // again and her entry answers exactly as a missing one. Keeping it is pure growth.
    const later = new Date(AT.getTime() + 5 * 60_000);
    guard.remember('bob', totpStep(later), later);
    expect(guard.size).toBe(1);
    expect(guard.isUsed('bob', totpStep(later))).toBe(true);
  });

  test('the cap evicts the subject furthest from the live window, never the newest', () => {
    const guard = createTotpReplayGuard(TOTP_DRIFT_STEPS, 4);
    const step = totpStep(AT);
    for (const subject of ['a', 'b', 'c', 'd']) guard.remember(subject, step, AT);
    expect(guard.size).toBe(4);

    // One step on, over the cap, and nothing is dead yet — so live state goes, oldest first.
    const next = new Date(AT.getTime() + TOTP_STEP_SECONDS * 1000);
    guard.remember('e', totpStep(next), next);

    expect(guard.size).toBeLessThan(5);
    // The subject who just authenticated is the last one out: evicting them is what would hand
    // an attacker a replay of the code that subject just used.
    expect(guard.isUsed('e', totpStep(next))).toBe(true);
    expect(guard.isUsed('d', step)).toBe(true);
    // The least recently seen is the first one out.
    expect(guard.isUsed('a', step)).toBe(false);
  });
});

describe('recovery codes', () => {
  test('a code works once and is dead the second time', () => {
    const set = generateRecoveryCodes(3);
    expect(set.codes).toHaveLength(3);
    expect(set.hashes).toHaveLength(3);
    const code = set.codes[0] as string;
    // Hashed at rest: the plaintext never appears in what is persisted.
    expect(set.hashes.join(',')).not.toContain(code.replaceAll('-', ''));

    const remaining = redeemRecoveryCode(code, set.hashes);
    expect(remaining).toHaveLength(2);
    expect(redeemRecoveryCode(code, remaining ?? [])).toBeNull();
  });

  test('formatting is ignored and an unknown code never matches', () => {
    const set = generateRecoveryCodes(2);
    const code = set.codes[0] as string;
    expect(redeemRecoveryCode(code.replaceAll('-', '').toLowerCase(), set.hashes)).toHaveLength(1);
    expect(redeemRecoveryCode('ZZZZ-ZZZZ-ZZZZ-ZZZZ', set.hashes)).toBeNull();
  });
});

/**
 * The error is the ONLY thing the framework hands an app author when a password is proven and a
 * second factor is not — there is no completion route, no `completeMfa()` and no pending-MFA
 * credential (`packages/auth/CLAUDE.md` carries the design constraint for the follow-up). So the
 * `fix:` has to name things that exist, and the cause must not publish an internal user id: both
 * `X_MFA_REQUIRED` surfaces (`oauth-route.ts`'s `publicBody`, http's problem document) serialise
 * `cause` to an anonymous caller and neither serialises `meta`.
 */
describe('X_MFA_REQUIRED', () => {
  test('the fix names no route this package does not mount', () => {
    expect(mfaRequired('user-42').fix).not.toContain('/auth/mfa');
  });

  test('the fix names the exports that actually finish the second factor', () => {
    const fix = mfaRequired('user-42').fix;
    expect(fix).toContain('verifyTotp');
    expect(fix).toContain('createSession');
    expect(fix).toContain('mfaSatisfied');
  });

  test('the user id is meta, never the cause an anonymous caller reads back', () => {
    const error = mfaRequired('user-42');
    expect(error.cause).not.toContain('user-42');
    expect(error.meta?.['userId']).toBe('user-42');
  });
});
