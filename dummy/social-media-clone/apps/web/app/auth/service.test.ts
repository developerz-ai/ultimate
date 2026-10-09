// unit — sign-in, sessions, and the graph an actor carries. Runs against the same in-process
// memory driver and memory auth adapter `x dev` uses, seeded with the same fixture, so a case that
// passes here is the case the running app has.
//
// The refusals come first and there are more of them than there are successes. A sign-in that
// works proves the happy path; a sign-in that refuses proves the check exists at all.

import { seedDemo } from '@social-media-clone/db';
import { userId } from '@social-media-clone/domain';
import { createSession, register } from '@ultimat3/auth';
import { actorFact } from '@ultimat3/core';
import { beforeAll, expect, unitTest } from '@ultimat3/testing';
import { CAPTCHA_AFTER_FAILURES } from '../../shared/auth-policy';
import { appAuth, resetAppAuth } from './auth';
import { ensureDemoCredentials, resetDemoCredentials } from './bootstrap';
import { useCaptcha } from './captcha';
import { acceptedFriendIds, blockedIdsBothWays, userByHandle, userIdByHandle } from './repo';
import { resetFailures, signIn, signOut, signUp } from './service';
import { viewerFor } from './viewer';

beforeAll(async () => {
  await seedDemo();
  resetAppAuth();
  resetDemoCredentials();
  resetFailures();
});

const idOf = async (handle: string): Promise<string> => {
  const user = await userByHandle(handle);
  if (user === null) throw new Error(`the seed has no @${handle}`);
  return user.id;
};

unitTest(
  'a wrong password is refused, and refused with the same code as an unknown handle',
  async () => {
    // One code for both, deliberately: two codes are an account-enumeration oracle. See errors.ts.
    await expect(signIn({ handle: 'user', password: 'wrong', captchaToken: null })).rejects.toThrow(
      /X_AUTH_CREDENTIALS_INVALID/,
    );
    await expect(
      signIn({ handle: 'nobody', password: 'user', captchaToken: null }),
    ).rejects.toThrow(/X_AUTH_CREDENTIALS_INVALID/);
    resetFailures();
  },
);

unitTest('the two demo logins work, and the handle is matched case-insensitively', async () => {
  const issued = await signIn({ handle: 'USER', password: 'user', captchaToken: null });
  expect(issued.token.length).toBeGreaterThan(0);
  // `users.role` lands in `actor.roles`, because that is what @ultimat3/policy expands into the
  // permission set. A `role` field beside it would be a column nothing reads.
  expect(issued.actor.roles).toEqual(['member']);

  const admin = await signIn({ handle: 'admin', password: 'admin', captchaToken: null });
  expect(admin.actor.roles).toEqual(['admin']);
});

unitTest('the issued token names its session, and nothing near it does', async () => {
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null });
  expect((await viewerFor(issued.token))?.id).toBe(userId(await idOf('user')));
  // A token one character off, a forged one and none at all are anonymous — never an error page.
  expect(await viewerFor(`${issued.token}x`)).toBe(null);
  expect(await viewerFor('not-a-session-token')).toBe(null);
  expect(await viewerFor('')).toBe(null);
  expect(await viewerFor(null)).toBe(null);
});

unitTest('an expired session is anonymous', async () => {
  const past = new Date(Date.now() - 60_000);
  const expired = await createSession(appAuth().sessions, {
    userId: await idOf('user'),
    createdAt: past,
    absoluteExpiresAt: past,
  });
  expect(await viewerFor(expired.token)).toBe(null);
});

unitTest('signing out revokes the row, and signing out twice is not an error', async () => {
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null });
  expect(await signOut(issued.token)).toBe(true);
  expect(await viewerFor(issued.token)).toBe(null);
  // A second click, or a stale tab, must not be a 500.
  expect(await signOut(issued.token)).toBe(false);
  expect(await signOut(null)).toBe(false);
});

unitTest('the block set is symmetric — one row hides the pair both ways', async () => {
  // The seed holds exactly one block row: mara blocked user. Neither may see the other.
  const [user, mara] = await Promise.all([idOf('user'), idOf('mara')]);
  expect(await blockedIdsBothWays(user)).toContain(mara);
  expect(await blockedIdsBothWays(mara)).toContain(user);

  // And the actor carries it flattened, so `isBlocked` is one set lookup in a synchronous
  // predicate rather than two queries per row per subscriber.
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null });
  expect(actorFact(issued.actor, 'blockedIds')?.has(mara)).toBe(true);
});

unitTest('friendship is accepted-only and direction-blind', async () => {
  const [user, ada, bruno, kenji] = await Promise.all([
    idOf('user'),
    idOf('ada'),
    idOf('bruno'),
    idOf('kenji'),
  ]);
  const friends = new Set(await acceptedFriendIds(user));
  // user→ada (user asked) and bruno→user (bruno asked): both accepted, both count.
  expect(friends.has(ada)).toBe(true);
  expect(friends.has(bruno)).toBe(true);
  // kenji→user is PENDING, and mara is declined. Neither is a friendship.
  expect(friends.has(kenji)).toBe(false);
  expect(friends.has(user)).toBe(false);
});

unitTest('sign-in demands the captcha only after repeated failures, and fails closed', async () => {
  resetFailures();
  useCaptcha({ name: 'test', enabled: true, verify: () => Promise.resolve(false) });
  try {
    for (let attempt = 0; attempt < CAPTCHA_AFTER_FAILURES; attempt += 1) {
      // Below the threshold the refusal is still about the password — a challenge on the first
      // attempt is a tax on every honest sign-in.
      await expect(
        signIn({ handle: 'user', password: 'wrong', captchaToken: null }),
      ).rejects.toThrow(/X_AUTH_CREDENTIALS_INVALID/);
    }
    // At the threshold the challenge comes first, and a verifier that says no stops the attempt
    // BEFORE the password is checked — even with the correct password.
    await expect(
      signIn({ handle: 'user', password: 'user', captchaToken: 'anything' }),
    ).rejects.toThrow(/X_AUTH_CAPTCHA_FAILED/);
  } finally {
    useCaptcha(undefined);
    resetFailures();
  }
});

unitTest('sign-up is challenged on the FIRST attempt, unlike sign-in', async () => {
  useCaptcha({ name: 'test', enabled: true, verify: () => Promise.resolve(false) });
  try {
    await expect(
      signUp({
        handle: 'fresh',
        displayName: 'Fresh',
        email: 'fresh@demo.example',
        password: 'a-long-enough-password',
        captchaToken: null,
      }),
    ).rejects.toThrow(/X_AUTH_CAPTCHA_FAILED/);
  } finally {
    useCaptcha(undefined);
  }
});

unitTest('sign-up refuses a short password and a handle somebody holds', async () => {
  await expect(
    signUp({
      handle: 'brandnew',
      displayName: 'New',
      email: 'n@demo.example',
      password: 'short',
      captchaToken: null,
    }),
  ).rejects.toThrow(/X_PASSWORD_WEAK/);

  await expect(
    signUp({
      handle: 'ada',
      displayName: 'Not Ada',
      email: 'x@demo.example',
      password: 'a-long-enough-password',
      captchaToken: null,
    }),
  ).rejects.toThrow(/X_AUTH_HANDLE_TAKEN/);
});

unitTest('a new account is signed in with an empty graph, built by the one resolver', async () => {
  const issued = await signUp({
    handle: 'newcomer',
    displayName: 'New Comer',
    email: 'newcomer@demo.example',
    password: 'a-long-enough-password',
    captchaToken: null,
  });
  expect(actorFact(issued.actor, 'friendIds')?.size).toBe(0);
  expect(actorFact(issued.actor, 'blockedIds')?.size).toBe(0);
  expect((await viewerFor(issued.token))?.id).toBe(issued.actor.id);
});

unitTest('sign-up refuses an address an account already uses', async () => {
  await expect(
    signUp({
      handle: 'second',
      displayName: 'Second',
      email: 'USER@demo.example',
      password: 'a-long-enough-password',
      captchaToken: null,
    }),
  ).rejects.toThrow(/X_AUTH_EMAIL_TAKEN/);
});

unitTest('a new account is an auth user under its users row id, signed in by handle', async () => {
  await signUp({
    handle: 'linked',
    displayName: 'Linked',
    email: 'linked@demo.example',
    password: 'a-long-enough-password',
    captchaToken: null,
  });
  const id = await idOf('linked');
  expect((await appAuth().adapter.findUserById(id))?.email).toBe('linked@demo.example');
  const issued = await signIn({
    handle: 'Linked',
    password: 'a-long-enough-password',
    captchaToken: null,
  });
  expect(issued.actor.id).toBe(userId(id));
});

unitTest('a handle resolves to its users row id, and an unknown one to nobody', async () => {
  expect(await userIdByHandle('user')).toBe(await idOf('user'));
  expect(await userIdByHandle('nobody')).toBe(null);
});

unitTest('a bootstrap run again finds its rows and writes nothing', async () => {
  resetDemoCredentials();
  // The rows exist before this run tries — another process, or this one before a restart — so it
  // settles without a write, and the next sign-in is the same user.
  const auth = appAuth();
  const id = await idOf('admin');
  expect(await auth.adapter.findUserById(id)).not.toBe(null);
  await ensureDemoCredentials();
  const admin = await signIn({ handle: 'admin', password: 'admin', captchaToken: null });
  expect(admin.actor.roles).toEqual(['admin']);
});

unitTest('a bootstrap that cannot write fails loudly, and is not remembered as done', async () => {
  resetAppAuth();
  resetDemoCredentials();
  // Another auth user already holds the demo login's address under a different id: the insert is
  // refused, no row carries the `users` id, and the refusal reaches the caller.
  await register(appAuth(), { email: 'user@demo.example', password: 'a-long-enough-password' });
  try {
    await expect(ensureDemoCredentials()).rejects.toThrow();
    await expect(ensureDemoCredentials()).rejects.toThrow();
  } finally {
    resetAppAuth();
    resetDemoCredentials();
  }
});
