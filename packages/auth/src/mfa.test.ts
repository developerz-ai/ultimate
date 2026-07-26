import { describe, expect, test } from 'bun:test';
import {
  base32Decode,
  base32Encode,
  createTotpReplayGuard,
  enrolTotp,
  generateRecoveryCodes,
  redeemRecoveryCode,
  totpCode,
  totpStep,
  verifyTotp,
} from './mfa';

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
    const enrolment = enrolTotp({
      issuer: 'Ultimate',
      account: 'ada@example.test',
      secret: SECRET,
    });
    expect(enrolment.uri.startsWith('otpauth://totp/Ultimate:ada%40example.test?')).toBe(true);
    expect(enrolment.uri).toContain(`secret=${SECRET}`);
    expect(enrolment.uri).toContain('algorithm=SHA1');
    expect(enrolment.uri).toContain('period=30');
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
