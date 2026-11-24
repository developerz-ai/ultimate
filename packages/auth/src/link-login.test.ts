// A mailed link as a sign-in door. The failure case first: with TOTP enrolled, a consumed link
// must end in the sealed challenge `completeMfa` takes and write no session — before this file's
// subject existed an app composed `consumeVerification` + `createSession` by hand, and the second
// factor was whatever that hand remembered.

import { describe, expect, test } from 'bun:test';
import { type FrozenClock, frozenClock, isUltimateError } from '@ultimat3/core';
import { type Auth, authenticate, defineAuth, login, register } from './auth';
import { caught, FAST_PARAMS, PASSWORD } from './auth-fixture';
import { signInWithLink } from './link-login';
import { type MemoryAuthAdapter, memoryAuthAdapter } from './memory-adapter';
import { TOTP_STEP_SECONDS, totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { saveTotpSecret } from './mfa-secret';
import { disableUser } from './revocation';
import {
  defineVerificationPurpose,
  emailVerification,
  passwordReset,
  type VerificationRuntime,
} from './verify';

const EMAIL = 'ada@corp.test';
const SECRET = 'JBSWY3DPEHPK3PXP';
const START = 1_700_000_000_000;
const TTL_MS = 15 * 60 * 1000;

/**
 * A fresh name per evaluation: the registry is process-wide and refuses a repeat, and this file
 * may be evaluated more than once in one process (`bun test --rerun-each`).
 */
const freshName = (base: string): string => `${base}-${crypto.randomUUID()}`;

const signInLink = defineVerificationPurpose({
  name: freshName('link-login-test'),
  template: 'auth.sign-in-link',
  ttlMs: TTL_MS,
});

interface World {
  readonly auth: Auth;
  readonly adapter: MemoryAuthAdapter;
  readonly clock: FrozenClock;
  readonly runtime: VerificationRuntime;
}

const world = (): World => {
  const clock = frozenClock(START);
  const adapter = memoryAuthAdapter(clock);
  const auth = defineAuth({
    adapter,
    clock,
    password: { minLength: 12, params: FAST_PARAMS },
    rateLimit: { maxAttempts: 5, orgMaxAttempts: 10_000 },
  });
  const runtime = { store: adapter, clock, mail: { send: async () => {} } };
  return { auth, adapter, clock, runtime };
};

/** A registered account that proved its address — the one a link may sign in. */
const verifiedUser = async ({ auth }: World, email = EMAIL): Promise<string> => {
  const user = await register(auth, { email, password: PASSWORD, orgId: 'org-1' });
  await auth.adapter.updateUser(user.id, { emailVerifiedAt: auth.clock.now() });
  return user.id;
};

const mailed = async ({ runtime }: World, identifier = EMAIL): Promise<string> =>
  (await signInLink.issue(runtime, { identifier, locale: 'en' })).token;

const redeem = (auth: Auth, token: string, identifier = EMAIL) =>
  signInWithLink(auth, { purpose: signInLink.name, identifier, token });

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
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(error?.meta).toBeUndefined();
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });

  test('an address no account holds is refused unless the call declares sign-up', async () => {
    const w = world();
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.findUserByEmail(EMAIL)).toBeNull();
  });

  test('an account that never proved its address is not claimed by a link', async () => {
    const w = world();
    // The pre-registration: somebody else chose this account's password.
    const user = await register(w.auth, { email: EMAIL, password: PASSWORD });
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(error?.fix).toContain('emailVerification');
    expect(await w.adapter.listSessions(user.id)).toHaveLength(0);
    expect((await w.adapter.findUserById(user.id))?.emailVerifiedAt).toBeNull();
    // And the password it was registered with is not what changed.
    expect((await login(w.auth, { email: EMAIL, password: PASSWORD })).session.userId).toBe(
      user.id,
    );
  });
});

describe('signInWithLink: declared sign-up', () => {
  test('a proven address with no account becomes a verified, passwordless one', async () => {
    const w = world();
    const result = await signInWithLink(w.auth, {
      purpose: signInLink.name,
      identifier: 'New@Corp.test',
      token: await mailed(w, 'new@corp.test'),
      signUp: { orgId: 'org-9', roles: ['member'] },
    });
    const user = await w.adapter.findUserByEmail('new@corp.test');
    expect(user?.id).toBe(result.session.userId);
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerifiedAt).toEqual(w.clock.now());
    expect(user?.orgId).toBe('org-9');
    expect([...(user?.roles ?? [])]).toEqual(['member']);
    expect(result.session.mfaSatisfied).toBe(true);
  });

  test('sign-up never rewrites an account that exists', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const result = await signInWithLink(w.auth, {
      purpose: signInLink.name,
      identifier: EMAIL,
      token: await mailed(w),
      signUp: { orgId: 'org-9', roles: ['owner'] },
    });
    expect(result.session.userId).toBe(userId);
    const user = await w.adapter.findUserById(userId);
    expect(user?.orgId).toBe('org-1');
    expect([...(user?.roles ?? [])]).toEqual([]);
  });

  test('a link issued before the account enrolled a second factor still owes it', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    const token = await mailed(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    w.clock.advance(TOTP_STEP_SECONDS * 1000);
    expect((await caught(() => redeem(w.auth, token)))?.code).toBe('X_MFA_REQUIRED');
    expect(await w.adapter.listSessions(userId)).toHaveLength(0);
  });
});

describe('signInWithLink: the purpose keys on the address', () => {
  const byPhone = defineVerificationPurpose({
    name: freshName('link-login-test-phone'),
    template: 'auth.sign-in-link',
    ttlMs: TTL_MS,
    identifier: (raw) => raw.replaceAll(' ', ''),
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
    expect(await w.adapter.findUserByEmail('+40700')).toBeNull();
    expect((await byPhone.consume(w.runtime, { identifier: '+40700', token })).identifier).toBe(
      '+40700',
    );
  });
});
