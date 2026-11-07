/**
 * The three WebAuthn refusals as a contract, not as three strings that happen to be in the tree.
 *
 * Each factory is held to four things an agent downstream depends on: the code is stable and
 * registered (`x errors explain` resolves it), the `cause` names the input that failed rather than
 * restating the title, the `fix:` is an instruction and not advice, and the whole refusal stays ONE
 * line however hostile the value interpolated into it — the last one because `cause` and `fix` end
 * up in line-oriented logs and CI transcripts, where a newline an attacker controlled is a second
 * line that reads as a genuine framework message.
 */

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode, singleLine } from '@ultimat3/core';
import { passkeyChallengeExpired, passkeyInvalid, passkeyStepUpRequired } from './passkey-errors';

/**
 * A cause no framework message would ever contain, so an echo of it is unambiguous — and one that
 * carries a REAL newline, an ANSI escape and a BEL rather than the printable spellings of them.
 * Holding `\u0007` as six characters instead, every `not.toContain` below would pass because the
 * input had nothing to escape: the fixture would measure the absence of a value, not the escaper.
 */
const HOSTILE = 'replayed challenge\nsecond line, control chars \u0007 and \u001b[2J';

const BUILT = [
  ['X_PASSKEY_INVALID', () => passkeyInvalid('credential id abc: signature did not verify')],
  [
    'X_PASSKEY_CHALLENGE_EXPIRED',
    () =>
      passkeyChallengeExpired({
        purpose: 'step-up',
        expiredAt: new Date('2026-11-05T00:00:00.000Z'),
      }),
  ],
  [
    'X_PASSKEY_STEP_UP_REQUIRED',
    () => passkeyStepUpRequired({ surface: 'posts.publish', digest: 'sha256:abc' }),
  ],
] as const;

describe('the passkey error factories', () => {
  for (const [code, build] of BUILT) {
    test(`${code} is built by a factory that still answers with it`, () => {
      const error = build();
      expect(error.code).toBe(code);
      expect(error.name).toBe('AuthError');
      expect(error.cause).not.toBe('');
      expect(error.fix).not.toBe('');
    });

    test(`${code} is registered by importing this module alone`, () => {
      // `describeErrorCode` answers a humanised fallback for an unregistered code, so the registry
      // is asked directly: `hasErrorCode` is false for a code nothing registered.
      expect(hasErrorCode(code), `${code} is not registered`).toBe(true);
      expect(describeErrorCode(code).title).not.toBe('');
    });

    test(`${code} carries a fix that is an instruction, never advice`, () => {
      // The same rule the `errors` step applies to every shipped `fix:`: a pasteable call, a
      // command, or a file — a banned phrase with none of those is the defect this asserts on.
      const fix = build().fix;
      expect(fix).toMatch(/[A-Za-z_$][\w$]*\(/);
      expect(fix).not.toMatch(/\b(?:check|make sure|try)\b/i);
    });
  }

  test('the cause names the value that failed, and never only the title again', () => {
    expect(passkeyInvalid('credential id abc: signature did not verify').cause).toContain(
      'credential id abc',
    );
    expect(
      passkeyChallengeExpired({ purpose: 'step-up', expiredAt: new Date('2026-11-05T00:00:00Z') })
        .cause,
    ).toContain('2026-11-05T00:00:00.000Z');
    expect(
      passkeyStepUpRequired({ surface: 'posts.publish', digest: 'sha256:abc' }).cause,
    ).toContain('posts.publish');
  });

  test('hostile values cannot open a second line in the cause', () => {
    // The escape is `UltimateError`'s, applied once at construction — this test is what keeps a
    // later edit from moving a factory onto a subclass that skips it.
    const error = passkeyInvalid(HOSTILE);
    expect(error.cause).not.toContain('\n');
    expect(error.cause).not.toContain('\r');
    expect(error.cause).not.toContain('\u001b');
    expect(error.cause).not.toContain('\u0007');
    // Escaped, not dropped: the reader still sees which value it was.
    expect(error.cause).toContain(String.raw`\n`);
    expect(error.cause).toBe(singleLine(HOSTILE));
  });

  test('hostile values cannot open a second line in the fix, the surface or the purpose', () => {
    for (const error of [
      passkeyStepUpRequired({ surface: HOSTILE, digest: 'sha256:abc' }),
      passkeyChallengeExpired({ purpose: HOSTILE, expiredAt: new Date('2026-11-05T00:00:00Z') }),
      passkeyInvalid(HOSTILE),
    ]) {
      expect(error.fix).not.toContain('\n');
      expect(error.code).not.toContain('\n');
    }
  });

  test('the digest a step-up refused is echoed as a quoted literal, so it parses', () => {
    const digest = 'sha256:9f2c';
    expect(passkeyStepUpRequired({ surface: 'posts.publish', digest }).fix).toContain(
      JSON.stringify(digest),
    );
    // The mechanism is `JSON.stringify`, so a hostile value is escaped INTO the literal rather than
    // swapped for a placeholder — the line still parses when pasted, and it still names the real
    // digest, which is the half a caller with two requests in flight needs.
    const hostile = passkeyStepUpRequired({ surface: 'posts.publish', digest: HOSTILE });
    expect(hostile.fix).toContain(JSON.stringify(HOSTILE));
    expect(hostile.fix).not.toContain('\n');
  });

  test('an Invalid Date degrades to prose instead of throwing a bare RangeError', () => {
    const error = passkeyChallengeExpired({ purpose: 'step-up', expiredAt: new Date(Number.NaN) });
    expect(error.code).toBe('X_PASSKEY_CHALLENGE_EXPIRED');
    expect(error.cause).toContain('an unrecorded instant');
    expect(error.meta?.['expiredAt']).toBe('an unrecorded instant');
  });

  test('the expiry instant rides in meta as an ISO string a second process can read', () => {
    const expiredAt = new Date('2026-11-05T00:00:00.000Z');
    const error = passkeyChallengeExpired({ purpose: 'step-up', expiredAt });
    expect(error.meta?.['expiredAt']).toBe('2026-11-05T00:00:00.000Z');
    expect(error.meta?.['purpose']).toBe('step-up');
  });

  test('an unverified assertion refuses as X_PASSKEY_INVALID and never a bare Error', () => {
    // The negative case the acceptance names: every rejection path aims at this one factory, so a
    // thrown value that is not an `AuthError` carrying the code is a contract break.
    const refusal = (): never => {
      throw passkeyInvalid('the assertion signature did not verify against the stored public key');
    };
    let caught: unknown;
    try {
      refusal();
      expect.unreachable('a refused ceremony must throw, never return');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { readonly code?: string }).code).toBe('X_PASSKEY_INVALID');
    expect((caught as { readonly name?: string }).name).toBe('AuthError');
  });
});
