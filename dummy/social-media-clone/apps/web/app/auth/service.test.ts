// unit — sign-in, sessions, and the graph an actor carries. Runs against the same in-process
// memory driver `x dev` uses, seeded with the same fixture, so a case that passes here is the case
// the running app has.
//
// The refusals come first and there are more of them than there are successes. A sign-in that
// works proves the happy path; a sign-in that refuses proves the check exists at all.

import { seedDemo } from '@social-media-clone/db';
import { userId } from '@social-media-clone/domain';
import { actorFact } from '@ultimat3/core';
import { beforeAll, expect, unitTest } from '@ultimat3/testing';
import { CAPTCHA_AFTER_FAILURES } from '../../shared/auth-policy';
import { hashToken, newSessionToken } from '../../shared/session';
import { resetDemoCredentials } from './bootstrap';
import { useCaptcha } from './captcha';
import { acceptedFriendIds, blockedIdsBothWays, insertSession, userByHandle } from './repo';
import { resetFailures, signIn, signOut, signUp } from './service';
import { viewerFor } from './viewer';

const NOW = new Date('2026-08-11T12:00:00.000Z');

beforeAll(async () => {
  await seedDemo();
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
    await expect(
      signIn({ handle: 'user', password: 'wrong', captchaToken: null }, NOW),
    ).rejects.toThrow(/X_AUTH_CREDENTIALS_INVALID/);
    await expect(
      signIn({ handle: 'nobody', password: 'user', captchaToken: null }, NOW),
    ).rejects.toThrow(/X_AUTH_CREDENTIALS_INVALID/);
    resetFailures();
  },
);

unitTest('the two demo logins work, and the handle is matched case-insensitively', async () => {
  const issued = await signIn({ handle: 'USER', password: 'user', captchaToken: null }, NOW);
  expect(issued.token.length).toBeGreaterThan(0);
  // `users.role` lands in `actor.roles`, because that is what @ultimat3/policy expands into the
  // permission set. A `role` field beside it would be a column nothing reads.
  expect(issued.actor.roles).toEqual(['member']);

  const admin = await signIn({ handle: 'admin', password: 'admin', captchaToken: null }, NOW);
  expect(admin.actor.roles).toEqual(['admin']);
});

unitTest('the issued token is stored HASHED — the row never holds a usable cookie', async () => {
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null }, NOW);
  // Resolving by the token works; resolving by what the row actually stores does not, which is
  // the whole point of storing the hash.
  expect((await viewerFor(issued.token, NOW))?.id).toBe(userId(await idOf('user')));
  expect(await viewerFor(hashToken(issued.token), NOW)).toBe(null);
});

unitTest('a token that does not match its stored hash is rejected', async () => {
  await signIn({ handle: 'user', password: 'user', captchaToken: null }, NOW);
  // A well-formed token nobody issued matches no row, because the lookup is on the digest.
  expect(await viewerFor(newSessionToken(), NOW)).toBe(null);
  expect(await viewerFor('', NOW)).toBe(null);
  expect(await viewerFor(null, NOW)).toBe(null);
});

unitTest('an expired session is rejected, and expiring exactly now counts as expired', async () => {
  const token = newSessionToken();
  await insertSession({
    userId: await idOf('user'),
    tokenHash: hashToken(token),
    expiresAt: NOW,
  });
  // `<=`, not `<`: a session whose absolute expiry is this instant is over.
  expect(await viewerFor(token, NOW)).toBe(null);
  expect(await viewerFor(token, new Date(NOW.getTime() + 1))).toBe(null);
  expect(await viewerFor(token, new Date(NOW.getTime() - 1))).not.toBe(null);
});

unitTest('signing out revokes the row, and signing out twice is not an error', async () => {
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null }, NOW);
  expect(await signOut(issued.token)).toBe(true);
  expect(await viewerFor(issued.token, NOW)).toBe(null);
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
  const issued = await signIn({ handle: 'user', password: 'user', captchaToken: null }, NOW);
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
        signIn({ handle: 'user', password: 'wrong', captchaToken: null }, NOW),
      ).rejects.toThrow(/X_AUTH_CREDENTIALS_INVALID/);
    }
    // At the threshold the challenge comes first, and a verifier that says no stops the attempt
    // BEFORE the password is checked — even with the correct password.
    await expect(
      signIn({ handle: 'user', password: 'user', captchaToken: 'anything' }, NOW),
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
      signUp(
        {
          handle: 'fresh',
          displayName: 'Fresh',
          email: 'fresh@demo.example',
          password: 'a-long-enough-password',
          captchaToken: null,
        },
        NOW,
      ),
    ).rejects.toThrow(/X_AUTH_CAPTCHA_FAILED/);
  } finally {
    useCaptcha(undefined);
  }
});

unitTest('sign-up refuses a short password and a handle somebody holds', async () => {
  await expect(
    signUp(
      {
        handle: 'brandnew',
        displayName: 'New',
        email: 'n@demo.example',
        password: 'short',
        captchaToken: null,
      },
      NOW,
    ),
  ).rejects.toThrow(/X_AUTH_PASSWORD_WEAK/);

  await expect(
    signUp(
      {
        handle: 'ada',
        displayName: 'Not Ada',
        email: 'x@demo.example',
        password: 'a-long-enough-password',
        captchaToken: null,
      },
      NOW,
    ),
  ).rejects.toThrow(/X_AUTH_HANDLE_TAKEN/);
});

unitTest('a new account is signed in with an empty graph, built by the one resolver', async () => {
  const issued = await signUp(
    {
      handle: 'newcomer',
      displayName: 'New Comer',
      email: 'newcomer@demo.example',
      password: 'a-long-enough-password',
      captchaToken: null,
    },
    NOW,
  );
  expect(actorFact(issued.actor, 'friendIds')?.size).toBe(0);
  expect(actorFact(issued.actor, 'blockedIds')?.size).toBe(0);
  expect((await viewerFor(issued.token, NOW))?.id).toBe(issued.actor.id);
});
