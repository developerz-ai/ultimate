import { describe, expect, test } from 'bun:test';
import { defineAuth } from './auth';
import { AuthError, mfaRequired } from './errors';
import { MemoryAdapter } from './memory-adapter';
import {
  base32Decode,
  base32Encode,
  createTotpReplayGuard,
  DEFAULT_MAX_TOTP_SUBJECTS,
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

/** The code an `UltimateError` carried, or the throw itself if it was not one. */
const codeOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return 'no throw';
};

const messageOf = (work: () => unknown): string => {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'no throw';
};

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

  /**
   * The secret is the ONLY thing a TOTP check knows, and an unreadable one leaves it knowing
   * nothing: `base32Decode` answers zero bytes for any character outside the alphabet, and an
   * HMAC keyed with zero bytes is a perfectly valid HMAC — so every malformed secret in the table
   * collapsed onto ONE code stream that anybody can compute without holding any secret. The code
   * below is derived independently, deliberately NOT through `totpCode`: once `totpCode` refuses
   * a zero-length key, deriving it through the function under test would make this vacuous.
   */
  const emptyKeyCode = (step: number): string => {
    const counter = new Uint8Array(8);
    let remaining = step;
    for (let index = 7; index >= 0; index -= 1) {
      counter[index] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
    const mac = Uint8Array.from(
      new Bun.CryptoHasher('sha1', new Uint8Array(0)).update(counter).digest(),
    );
    const offset = (mac[mac.length - 1] as number) & 0x0f;
    const binary =
      (((mac[offset] as number) & 0x7f) << 24) |
      (((mac[offset + 1] as number) & 0xff) << 16) |
      (((mac[offset + 2] as number) & 0xff) << 8) |
      ((mac[offset + 3] as number) & 0xff);
    return String(binary % 1_000_000).padStart(6, '0');
  };

  test('the empty-key code authenticates no secret the decoder cannot read', () => {
    const step = totpStep(AT);
    const code = emptyKeyCode(step);
    // '' is the reachable one: a `mfa_secret text not null default ''` column is not null, so
    // `login()` still demands a second factor and then had to be shown one derived from nothing.
    for (const secret of ['not base32 !!!', 'JBSWY3DP!!!!!!!!', '', 'A']) {
      expect(verifyTotp({ secret, code, at: AT })).toEqual({ ok: false, step: null });
    }
  });

  test('a secret that decodes to nothing produces no code at all', () => {
    const step = totpStep(AT);
    // Two different malformed secrets used to answer the same six digits. A refusal is the only
    // answer that cannot be one: there is no code an unreadable secret is entitled to.
    for (const secret of ['not base32 !!!', 'JBSWY3DP!!!!!!!!', '', 'A']) {
      expect(() => totpCode(secret, step)).toThrow(AuthError);
      expect(codeOf(() => totpCode(secret, step))).toBe('X_MFA_SECRET_INVALID');
    }
    // The secret never reaches the message: it is a credential, and the message is logged.
    expect(codeOf(() => totpCode('JBSWY3DP!!!!!!!!', step))).toBe('X_MFA_SECRET_INVALID');
    expect(messageOf(() => totpCode('JBSWY3DP!!!!!!!!', step))).not.toContain('JBSWY3DP');
  });

  test('an imported secret is refused at enrolment, before it reaches the table', () => {
    expect(
      codeOf(() => enrolTotp(authWith('Postly'), { account: 'ada@example.test', secret: '' })),
    ).toBe('X_MFA_SECRET_INVALID');
    expect(
      codeOf(() =>
        enrolTotp(authWith('Postly'), { account: 'ada@example.test', secret: 'not base32 !!!' }),
      ),
    ).toBe('X_MFA_SECRET_INVALID');
    // A minted secret is always readable, so the common path is untouched.
    expect(enrolTotp(authWith('Postly'), { account: 'ada@example.test' }).secret).toMatch(
      /^[A-Z2-7]+$/,
    );
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

  /**
   * `maxSubjects` is the caller's number and the cap arithmetic ran on it unchecked, so the two
   * values JavaScript hands you when a config read goes wrong each defeat the bound in their own
   * way — one silently, one catastrophically. Both fall back to the default now.
   */
  describe('a maxSubjects that is not a positive finite integer', () => {
    test('Infinity does not disable the bound it was passed as', () => {
      const guard = createTotpReplayGuard(TOTP_DRIFT_STEPS, Number.POSITIVE_INFINITY);
      const step = totpStep(AT);
      // One past the default, at a single step so nothing is forgotten by drift: the only thing
      // that can hold this table down is the cap.
      for (let index = 0; index <= DEFAULT_MAX_TOTP_SUBJECTS; index += 1) {
        guard.remember(`subject-${index}`, step, AT);
      }

      // `used.size > Infinity` is never true, so this is the exact unbounded map the cap exists
      // to prevent — reintroduced by a caller who meant "no limit".
      expect(guard.size).toBeLessThanOrEqual(DEFAULT_MAX_TOTP_SUBJECTS);
    });

    test('NaN does not make the guard forget the code it just accepted', () => {
      const guard = createTotpReplayGuard(TOTP_DRIFT_STEPS, Number.NaN);
      const step = totpStep(AT);
      guard.remember('alice', step, AT);

      // Every comparison against NaN is false, so `used.size <= evictTo` never stops the eviction
      // loop and the sweep empties the table — including the subject who just authenticated.
      // That is a replay of the six digits still on their screen, not merely a lost bound.
      expect(guard.isUsed('alice', step)).toBe(true);
      expect(guard.size).toBe(1);
    });

    test('zero is a misread config, not an instruction to remember one subject', () => {
      const guard = createTotpReplayGuard(TOTP_DRIFT_STEPS, 0);
      const step = totpStep(AT);
      guard.remember('alice', step, AT);
      guard.remember('bob', step, AT);

      // `Math.max(1, 0)` made the table hold exactly one subject, so alice's live step became
      // replayable the moment bob signed in.
      expect(guard.isUsed('alice', step)).toBe(true);
      expect(guard.size).toBe(2);
    });
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

/**
 * `drift` is a LOOP BOUND, not a comparison, and that makes it the worst of the four shapes.
 * Measured before the screen landed, on the login path, synchronously:
 *   `drift: Infinity` — `for (offset = -Infinity; offset <= Infinity; offset += 1)` never
 *     terminates (`-Infinity + 1` is `-Infinity`). Killed at 6s by a probe's timeout.
 *   `drift: NaN` — `-NaN <= NaN` is false, so the loop never runs and every CORRECT code is
 *     rejected: `{ ok: false, step: null }`, indistinguishable from a wrong one.
 *
 * HANG HAZARD for whoever edits `verifyTotp` next: removing the screen makes the `Infinity` case
 * below wedge this file rather than fail it. Mutate with the `NaN` case.
 */
describe('the TOTP drift window is screened before it becomes a loop bound', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses drift %p rather than looping or denying in silence',
    (drift) => {
      expect(codeOf(() => verifyTotp({ secret: SECRET, code: '000000', at: AT, drift }))).toBe(
        'X_CONFIG_INVALID',
      );
      expect(
        messageOf(() => verifyTotp({ secret: SECRET, code: '000000', at: AT, drift })),
      ).toContain('drift');
    },
  );

  test('zero is a window a deployment may choose: the current step and nothing either side', () => {
    const step = totpStep(AT);
    expect(verifyTotp({ secret: SECRET, code: totpCode(SECRET, step), at: AT, drift: 0 })).toEqual({
      ok: true,
      step,
    });
    expect(
      verifyTotp({ secret: SECRET, code: totpCode(SECRET, step - 1), at: AT, drift: 0 }),
    ).toEqual({ ok: false, step: null });
  });

  test('the shipped default still accepts the step either side', () => {
    const step = totpStep(AT);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp({ secret: SECRET, code: totpCode(SECRET, step + offset), at: AT }).ok).toBe(
        true,
      );
    }
    expect(TOTP_DRIFT_STEPS).toBe(1);
  });
});
