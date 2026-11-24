// A mailed link as a sign-in door. The failure case first: with TOTP enrolled, a consumed link
// must end in the sealed challenge `completeMfa` takes and write no session — before this file's
// subject existed an app composed `consumeVerification` + `createSession` by hand, and the second
// factor was whatever that hand remembered.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { authenticate, login, register } from './auth';
import { caught, PASSWORD } from './auth-fixture';
import { signInWithLink } from './link-login';
import {
  EMAIL,
  emailChange,
  freshName,
  mailed,
  redeem,
  SECRET,
  signInLink,
  TTL_MS,
  verifiedUser,
  world,
} from './link-login-fixture';
import { totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { saveTotpSecret } from './mfa-secret';
import { disableUser, enableUser } from './revocation';
import { defineVerificationPurpose, emailVerification, passwordReset } from './verify';

describe('signInWithLink: the second factor still applies', () => {
  test('with TOTP on, a link sign-in yields a challenge and no session', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);

    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    expect(error?.code).toBe('X_MFA_REQUIRED');
    expect(typeof error?.meta?.['challenge']).toBe('string');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test('the challenge and the current code finish the sign-in, with no password anywhere', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    const challenge = error?.meta?.['challenge'];
    if (typeof challenge !== 'string') return expect.unreachable('no challenge in meta');

    const code = totpCode(SECRET, totpStep(w.clock.now()));
    const result = await completeMfa(w.auth, challenge, code);
    expect(result.session.mfaSatisfied).toBe(true);
    expect((await authenticate(w.auth, result.token)).id).toBe(userId);
  });

  test('the link is spent by the first leg: it cannot be redeemed again for a second challenge', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    const token = await mailed(w);
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_MFA_REQUIRED');
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test('a wrong code after a link counts against the account, exactly as after a password', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    const challenge = String(error?.meta?.['challenge']);
    const live = [-1, 0, 1].map((offset) => totpCode(SECRET, totpStep(w.clock.now()) + offset));
    const wrong = live.includes('000000') ? '111111' : '000000';
    for (let guess = 0; guess < 5; guess += 1) {
      expect((await caught(() => completeMfa(w.auth, challenge, wrong)))?.code).toBe(
        'X_UNAUTHENTICATED',
      );
    }
    expect((await caught(() => completeMfa(w.auth, challenge, wrong)))?.code).toBe(
      'X_ACCOUNT_LOCKED',
    );
    // A fresh link does not clear the count: the first leg proves the inbox, not the code.
    const again = await caught(async () => redeem(w.auth, await mailed(w)));
    const second = String(again?.meta?.['challenge']);
    const right = totpCode(SECRET, totpStep(w.clock.now()));
    expect((await caught(() => completeMfa(w.auth, second, right)))?.code).toBe('X_ACCOUNT_LOCKED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });
});

describe('signInWithLink: one link, one sign-in', () => {
  test('without a second factor the link mints the session login() mints', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const result = await signInWithLink(w.auth, {
      purpose: signInLink.name,
      identifier: ' Ada@Corp.test ',
      token: await mailed(w),
      ip: '203.0.113.7',
      userAgent: 'test-agent',
    });
    expect(result.session.userId).toBe(userId);
    expect(result.session.mfaSatisfied).toBe(true);
    expect(result.session.ip).toBe('203.0.113.7');
    expect(result.cookie).toContain('__Host-x_session=');
    expect((await authenticate(w.auth, result.token)).id).toBe(userId);
  });

  test('a link is good once', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const token = await mailed(w);
    await redeem(w.auth, token);
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(1);
  });

  test('two redemptions racing one link mint one session', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const token = await mailed(w);
    const settled = await Promise.allSettled([redeem(w.auth, token), redeem(w.auth, token)]);
    expect(settled.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((one) => one.status === 'rejected');
    const reason: unknown = lost?.status === 'rejected' ? lost.reason : undefined;
    expect(isUltimateError(reason) ? reason.code : undefined).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(1);
  });

  test('an expired link signs nobody in, at the instant it expires', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const token = await mailed(w);
    w.clock.advance(TTL_MS);
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test('a wrong token signs nobody in and leaves the mailed link live', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const token = await mailed(w);
    expect((await caught(() => redeem(w.auth, `${token}x`)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
    expect((await redeem(w.auth, token)).session.userId).toBe(userId);
  });

  test("one address's link does not sign in another address", async () => {
    const w = world();
    await verifiedUser(w);
    const other = await verifiedUser(w, 'grace@corp.test');
    const token = await mailed(w);
    const error = await caught(() => redeem(w.auth, token, 'grace@corp.test'));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(other)).toHaveLength(0);
  });

  test('a newer link retires the older one', async () => {
    const w = world();
    await verifiedUser(w);
    const older = await mailed(w);
    const newer = await mailed(w);
    expect((await caught(() => redeem(w.auth, older)))?.code).toBe('X_UNAUTHENTICATED');
    expect((await redeem(w.auth, newer)).session.mfaSatisfied).toBe(true);
  });
});

describe('signInWithLink: what a link is not', () => {
  test('a token mailed for another purpose is not a sign-in', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const { token } = await emailVerification.issue(w.runtime, { identifier: EMAIL, locale: 'en' });
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test.each([emailVerification, passwordReset])(
    'a built-in purpose is refused as a sign-in door, and its token stays live',
    async (builtin) => {
      const w = world();
      const userId = await verifiedUser(w);
      const { token } = await builtin.issue(w.runtime, { identifier: EMAIL, locale: 'en' });
      let thrown: unknown;
      try {
        await signInWithLink(w.auth, { purpose: builtin.name, identifier: EMAIL, token });
      } catch (error) {
        thrown = error;
      }
      expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_CONFIG_INVALID');
      // The fix is a purpose of its own and a fresh link: this token cannot match another purpose.
      expect(isUltimateError(thrown) ? thrown.fix : '').toContain("name: 'sign-in'");
      expect(isUltimateError(thrown) ? thrown.fix : '').toContain('issue a fresh link');
      expect(await w.adapter.listSessions(userId)).toHaveLength(0);
      // Refused before the store was asked: the token still does the one job it was mailed for.
      const record = await builtin.consume(w.runtime, { identifier: EMAIL, token });
      expect(record.identifier).toBe(EMAIL);
    },
  );

  test('an undeclared purpose is refused by name', async () => {
    const w = world();
    await verifiedUser(w);
    const error = await caught(() =>
      signInWithLink(w.auth, { purpose: 'never-declared', identifier: EMAIL, token: 'x' }),
    );
    expect(error?.code).toBe('X_VERIFICATION_PURPOSE_UNKNOWN');
  });

  test('a disabled account is refused, and the refusal names nothing', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await disableUser(w.auth, userId, 'link-login test');
    const token = await mailed(w);
    const error = await caught(() => redeem(w.auth, token));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(error?.meta).toBeUndefined();
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
    // The refusal spent the link: re-enabled, the account still needs a fresh one.
    await enableUser(w.auth, userId);
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');
    expect((await redeem(w.auth, await mailed(w))).session.userId).toBe(userId);
  });

  test('a disabled account is refused with sign-up declared too, and answers as no account does', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await disableUser(w.auth, userId, 'link-login test');
    const withSignUp = await caught(async () =>
      signInWithLink(w.auth, {
        purpose: signInLink.name,
        identifier: EMAIL,
        token: await mailed(w),
        signUp: {},
      }),
    );
    const nobody = await caught(async () =>
      redeem(w.auth, await mailed(w, 'nobody@corp.test'), 'nobody@corp.test'),
    );
    expect(withSignUp?.code).toBe('X_UNAUTHENTICATED');
    expect(withSignUp?.message).toBe(nobody?.message);
    expect(withSignUp?.fix).toBe(nobody?.fix);
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test('an address no account holds is refused unless the call declares sign-up', async () => {
    const w = world();
    const token = await mailed(w);
    const error = await caught(() => redeem(w.auth, token));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    // The fix asks for a fresh link: this one is spent, sign-up or not.
    expect(error?.fix).toContain('freshly mailed link');
    expect(await w.adapter.findUserByEmail(EMAIL)).toBeNull();
    const retried = await caught(() =>
      signInWithLink(w.auth, { purpose: signInLink.name, identifier: EMAIL, token, signUp: {} }),
    );
    expect(retried?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.findUserByEmail(EMAIL)).toBeNull();
  });

  test('an account that never proved its address is not claimed by a link', async () => {
    const w = world();
    // The pre-registration: somebody else chose this account's password.
    const user = await register(w.auth, { email: EMAIL, password: PASSWORD });
    const token = await mailed(w);
    const error = await caught(() => redeem(w.auth, token));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(error?.fix).toContain('passwordReset.issue');
    expect(await w.adapter.listSessions(user.id)).toHaveLength(0);
    expect((await w.adapter.findUserById(user.id))?.emailVerifiedAt).toBeNull();
    // And the password it was registered with is not what changed.
    expect((await login(w.auth, { email: EMAIL, password: PASSWORD })).session.userId).toBe(
      user.id,
    );
    // The refusal spent the link: made eligible, with no link issued in between, it is still refused.
    await w.adapter.updateUser(user.id, { emailVerifiedAt: w.clock.now() });
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_UNAUTHENTICATED');

    // Sign-up declared changes nothing: the address is held. Its own token, spent the same way.
    await w.adapter.updateUser(user.id, { emailVerifiedAt: null });
    const signUpToken = await mailed(w);
    const withSignUp = await caught(() =>
      signInWithLink(w.auth, {
        purpose: signInLink.name,
        identifier: EMAIL,
        token: signUpToken,
        signUp: {},
      }),
    );
    expect(withSignUp?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.listSessions(user.id)).toHaveLength(1);
    await w.adapter.updateUser(user.id, { emailVerifiedAt: w.clock.now() });
    expect((await caught(() => redeem(w.auth, signUpToken)))?.code).toBe('X_UNAUTHENTICATED');
    // The control: the account is eligible now, so a fresh link signs in.
    expect((await redeem(w.auth, await mailed(w))).session.userId).toBe(user.id);
  });

  test('the remedy the refusal names takes every credential the registrant set with it', async () => {
    const w = world();
    // The pre-registration, signed in and holding a second factor, recovery codes and a passkey.
    const user = await register(w.auth, { email: EMAIL, password: PASSWORD });
    const registrant = await login(w.auth, { email: EMAIL, password: PASSWORD });
    await saveTotpSecret(w.auth, user.id, SECRET);
    await w.adapter.updateUser(user.id, { recoveryCodeHashes: ['registrant-recovery-digest'] });
    await w.adapter.putPasskey({
      id: 'registrant-passkey',
      userId: user.id,
      publicKey: 'cose-key',
      algorithm: -7,
      signCount: 0,
      transports: [],
      createdAt: w.clock.now(),
      lastUsedAt: null,
    });
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    expect(error?.fix).toContain('passwordReset.issue');
    expect(error?.fix).toContain('disableUser');

    // The inbox's owner follows it: the reset link only proves the address, then the account is
    // shut, every credential the registrant set goes, and the stamp reopens it last.
    const { token } = await passwordReset.issue(w.runtime, { identifier: EMAIL, locale: 'en' });
    await passwordReset.consume(w.runtime, { identifier: EMAIL, token });
    await disableUser(w.auth, user.id, 'address proven by reset');
    await w.adapter.updateUser(user.id, {
      passwordHash: null,
      mfaSecret: null,
      recoveryCodeHashes: [],
    });
    for (const passkey of await w.adapter.listPasskeys(user.id)) {
      await w.adapter.deletePasskey(user.id, passkey.id);
    }
    // Mid-recipe the account is shut and unverified: neither the registrant nor a link gets in.
    expect((await caught(() => authenticate(w.auth, registrant.token)))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
    expect((await caught(async () => redeem(w.auth, await mailed(w))))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
    await w.adapter.updateUser(user.id, { emailVerifiedAt: w.clock.now(), disabledAt: null });

    const result = await redeem(w.auth, await mailed(w));
    expect(result.session.userId).toBe(user.id);
    expect(result.session.mfaSatisfied).toBe(true);
    expect((await caught(() => authenticate(w.auth, registrant.token)))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
    expect((await caught(() => login(w.auth, { email: EMAIL, password: PASSWORD })))?.code).toBe(
      'X_UNAUTHENTICATED',
    );
    const handedOver = await w.adapter.findUserById(user.id);
    expect(handedOver?.recoveryCodeHashes).toEqual([]);
    expect(handedOver?.mfaSecret).toBeNull();
    expect(await w.adapter.listPasskeys(user.id)).toEqual([]);
  });

  test('an interrupted account cleanup cannot be reopened while credentials remain', async () => {
    const w = world();
    const user = await register(w.auth, { email: EMAIL, password: PASSWORD });
    await saveTotpSecret(w.auth, user.id, SECRET);
    await disableUser(w.auth, user.id, 'address proven by reset');
    await w.adapter.updateUser(user.id, { passwordHash: null });
    await enableUser(w.auth, user.id);
    expect((await w.adapter.findUserById(user.id))?.disabledAt).not.toBeNull();
  });

  test('a purpose that keys on the address but is not declared sign-in is refused, and its token stays live', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const { token } = await emailChange.issue(w.runtime, { identifier: EMAIL, locale: 'en' });
    let thrown: unknown;
    try {
      await signInWithLink(w.auth, { purpose: emailChange.name, identifier: EMAIL, token });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_CONFIG_INVALID');
    // Never "declare the same name signIn": that would promote links already mailed for another job.
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain("name: 'sign-in'");
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain('signIn: true');
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain('issue a fresh link');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
    expect((await emailChange.consume(w.runtime, { identifier: EMAIL, token })).identifier).toBe(
      EMAIL,
    );
  });
});

describe('signInWithLink: the purpose keys on the address', () => {
  const byPhone = defineVerificationPurpose({
    name: freshName('link-login-test-phone'),
    template: 'auth.sign-in-link',
    ttlMs: TTL_MS,
    identifier: (raw) => raw.replaceAll(' ', ''),
    signIn: true,
  });

  test('a purpose with its own identifier is refused, and its token stays live', async () => {
    const w = world();
    const { token } = await byPhone.issue(w.runtime, { identifier: '+40 700', locale: 'en' });
    let thrown: unknown;
    try {
      await signInWithLink(w.auth, {
        purpose: byPhone.name,
        identifier: '+40700',
        token,
        signUp: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown) ? thrown.code : undefined).toBe('X_CONFIG_INVALID');
    // The fix names a dedicated sign-in purpose, so following it works.
    expect(isUltimateError(thrown) ? thrown.fix : '').toContain(
      'ttlMs: 15 * 60 * 1000, signIn: true })',
    );
    expect(await w.adapter.findUserByEmail('+40700')).toBeNull();
    expect((await byPhone.consume(w.runtime, { identifier: '+40700', token })).identifier).toBe(
      '+40700',
    );
  });
});
