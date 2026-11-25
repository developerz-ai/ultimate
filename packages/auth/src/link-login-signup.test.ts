// A mailed link's two follow-ons: the declared sign-up an address with no account may take, and
// the second leg a TOTP account owes after the link — one attempt budget with the password door,
// and the session's metadata stamped by the leg that writes it.

import { describe, expect, test } from 'bun:test';
import { login } from './auth';
import { caught, PASSWORD } from './auth-fixture';
import { signInWithLink } from './link-login';
import {
  EMAIL,
  mailed,
  redeem,
  SECRET,
  signInLink,
  verifiedUser,
  world,
} from './link-login-fixture';
import { TOTP_STEP_SECONDS, totpCode, totpStep } from './mfa';
import { completeMfa } from './mfa-challenge';
import { saveTotpSecret } from './mfa-secret';

describe('signInWithLink: the second leg', () => {
  test('wrong passwords and wrong codes after a link spend one budget for the account', async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    for (let guess = 0; guess < 3; guess += 1) {
      expect(
        (await caught(() => login(w.auth, { email: EMAIL, password: `${PASSWORD}-wrong` })))?.code,
      ).toBe('X_UNAUTHENTICATED');
    }
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    const challenge = String(error?.meta?.['challenge']);
    const live = [-1, 0, 1].map((offset) => totpCode(SECRET, totpStep(w.clock.now()) + offset));
    const wrong = live.includes('000000') ? '111111' : '000000';
    for (let guess = 0; guess < 2; guess += 1) {
      expect((await caught(() => completeMfa(w.auth, challenge, wrong)))?.code).toBe(
        'X_UNAUTHENTICATED',
      );
    }
    // 3 + 2 = maxAttempts: the next guess on either door is held.
    expect((await caught(() => completeMfa(w.auth, challenge, wrong)))?.code).toBe(
      'X_ACCOUNT_LOCKED',
    );
    expect((await caught(() => login(w.auth, { email: EMAIL, password: PASSWORD })))?.code).toBe(
      'X_ACCOUNT_LOCKED',
    );
  });

  test("with TOTP, the session's address and agent come from the leg that writes it", async () => {
    const w = world();
    const userId = await verifiedUser(w);
    await saveTotpSecret(w.auth, userId, SECRET);
    const error = await caught(async () => redeem(w.auth, await mailed(w)));
    const result = await completeMfa(
      w.auth,
      String(error?.meta?.['challenge']),
      totpCode(SECRET, totpStep(w.clock.now())),
      { ip: '203.0.113.9', userAgent: 'second-leg' },
    );
    expect(result.session.ip).toBe('203.0.113.9');
    expect(result.session.userAgent).toBe('second-leg');
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

  test('a bad link with sign-up declared creates no account', async () => {
    const w = world();
    const token = await mailed(w, 'new@corp.test');
    const error = await caught(() =>
      signInWithLink(w.auth, {
        purpose: signInLink.name,
        identifier: 'new@corp.test',
        token: `${token}x`,
        signUp: {},
      }),
    );
    expect(error?.code).toBe('X_UNAUTHENTICATED');
    expect(await w.adapter.findUserByEmail('new@corp.test')).toBeNull();
  });

  test('the account is created verified in one write: no later write can strand it', async () => {
    const w = world();
    // A store whose every later user write fails, counted: the creating write is the only one.
    let updates = 0;
    w.adapter.updateUser = async () => {
      updates += 1;
      return null;
    };
    const result = await signInWithLink(w.auth, {
      purpose: signInLink.name,
      identifier: 'new@corp.test',
      token: await mailed(w, 'new@corp.test'),
      signUp: {},
    });
    const user = await w.adapter.findUserByEmail('new@corp.test');
    expect(user?.emailVerifiedAt).toEqual(w.clock.now());
    expect(result.session.userId).toBe(user?.id ?? '');
    // And the next link signs the same account in.
    expect(
      (await redeem(w.auth, await mailed(w, 'new@corp.test'), 'new@corp.test')).session.userId,
    ).toBe(user?.id ?? '');
    expect(updates).toBe(0);
  });

  test('an adapter that drops the creation stamp gets it in a second write, and stays reachable', async () => {
    const w = world();
    // An app adapter written before `CreateUserInput.emailVerifiedAt`: it stores the row unstamped.
    const create = w.adapter.createUser.bind(w.adapter);
    w.adapter.createUser = (input) => create({ ...input, emailVerifiedAt: undefined });
    const result = await signInWithLink(w.auth, {
      purpose: signInLink.name,
      identifier: 'new@corp.test',
      token: await mailed(w, 'new@corp.test'),
      signUp: {},
    });
    const user = await w.adapter.findUserByEmail('new@corp.test');
    expect(user?.emailVerifiedAt).toEqual(w.clock.now());
    expect(result.session.userId).toBe(user?.id ?? '');
    expect(
      (await redeem(w.auth, await mailed(w, 'new@corp.test'), 'new@corp.test')).session.userId,
    ).toBe(user?.id ?? '');
  });

  test('a failed second stamp is X_AUTH_WRITE_FAILED, never a session on an unverified account', async () => {
    const w = world();
    const create = w.adapter.createUser.bind(w.adapter);
    w.adapter.createUser = (input) => create({ ...input, emailVerifiedAt: undefined });
    w.adapter.updateUser = async () => null;
    const token = await mailed(w, 'new@corp.test');
    const error = await caught(() =>
      signInWithLink(w.auth, {
        purpose: signInLink.name,
        identifier: 'new@corp.test',
        token,
        signUp: {},
      }),
    );
    expect(error?.code).toBe('X_AUTH_WRITE_FAILED');
    const user = await w.adapter.findUserByEmail('new@corp.test');
    expect(user?.emailVerifiedAt).toBeNull();
    expect(await w.adapter.listSessions(user?.id ?? '')).toHaveLength(0);
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
