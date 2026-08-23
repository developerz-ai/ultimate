// `signInWithOAuth`: one profile turned into a user, an account link and a session — and every
// refusal on the way. The callback that produces the profile is `oauth-login-callback.test.ts`
// and the grant seam applied to the result is `oauth-login-grants.test.ts`.

import { beforeEach, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import { type Auth, defineAuth } from './auth';
import { MemoryAdapter } from './memory-adapter';
import { signInWithOAuth } from './oauth-login';
import { codeOf, freshAuth, NOW, profile, tokens } from './oauth-login-fixture';

let adapter: MemoryAdapter;
let auth: Auth;

beforeEach(() => {
  ({ adapter, auth } = freshAuth());
});

/**
 * Accepts the new row and loses every patch — the shape of an `AuthAdapter` whose `updateUser`
 * does not return what it wrote. `emailVerifiedAt` is not in `CreateUserInput`, so this is the
 * one path where a lost patch would leave a signed-in user that no later login can link.
 */
class StampLosingAdapter extends MemoryAdapter {
  override async updateUser(): Promise<AuthUser | null> {
    return null;
  }
}

describe('signInWithOAuth', () => {
  test('a first-time identity becomes a user, an account and a session', async () => {
    const result = await signInWithOAuth(auth, { profile: profile(), tokens: tokens() });

    expect(result.actor.kind).toBe('user');
    expect(result.cookie).toContain('__Host-x_session=');
    expect(result.session.mfaSatisfied).toBe(true);

    const user = await adapter.findUserByEmail('ada@example.com');
    // An OAuth-only account carries no password hash — not even an unguessable one.
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerifiedAt).toEqual(NOW);

    const account = await adapter.findAccount('github', '583231');
    expect(account?.userId).toBe(user?.id ?? '');
    // NOT PERSISTED. `x_accounts.access_token` / `refresh_token` held a live provider credential
    // in the clear, under a `tables.ts` header promising "no column holds a plaintext secret", and
    // NOTHING in this package ever read either one back — `oauth-profile.ts` uses the token from
    // the exchange, in flight. `packages/auth/CLAUDE.md` says refresh is not implemented. So this
    // is the "declared and never wired" deletion, and the type keeps the columns because
    // `AuthAccount` is the documented adapter seam.
    expect(account?.accessToken).toBeNull();
    expect(account?.refreshToken).toBeNull();
  });

  test('a verified stamp the adapter loses fails closed, with no session and no link', async () => {
    const losing = new StampLosingAdapter();
    const failing = defineAuth({
      adapter: losing,
      clock: frozenClock(NOW),
      providers: ['github', 'google'],
    });

    expect(await codeOf(signInWithOAuth(failing, { profile: profile(), tokens: tokens() }))).toBe(
      'X_NOT_IMPLEMENTED',
    );
    const created = await losing.findUserByEmail('ada@example.com');
    // The row exists and is unverified — which is exactly why signing it in was the bug.
    expect(created?.emailVerifiedAt).toBeNull();
    expect(await losing.findAccount('github', '583231')).toBeNull();
    expect(await losing.listSessions(created?.id ?? '')).toEqual([]);
  });

  test('the second login reuses the linked user and stores no token either time', async () => {
    const first = await signInWithOAuth(auth, { profile: profile(), tokens: tokens() });
    const linked = await adapter.findAccount('github', '583231');

    const second = await signInWithOAuth(auth, {
      profile: profile({ email: 'renamed@example.com' }),
      tokens: tokens({ accessToken: 'gho_second' }),
    });

    expect(second.actor.id).toBe(first.actor.id);
    const account = await adapter.findAccount('github', '583231');
    expect(account?.accessToken).toBeNull();
    // The row keeps its own identity: the provider account never changes hands.
    expect(account?.id).toBe(linked?.id ?? '');
    expect(account?.createdAt).toEqual(linked?.createdAt ?? NOW);
    expect(await adapter.findUserByEmail('renamed@example.com')).toBeNull();
  });

  test('a verified address attaches to an account that verified the same address', async () => {
    const existing = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: 'argon2id$…',
      orgId: null,
      roles: ['editor'],
      createdAt: NOW,
    });
    await adapter.updateUser(existing.id, { emailVerifiedAt: NOW });

    const result = await signInWithOAuth(auth, { profile: profile(), tokens: tokens() });

    expect(result.actor.id).toBe('user-1');
    expect(result.actor.roles).toEqual(['editor']);
    expect((await adapter.listAccounts('user-1')).length).toBe(1);
  });

  test("link: 'never' refuses a collision even when both halves verified the address", async () => {
    const strict = defineAuth({
      adapter,
      clock: frozenClock(NOW),
      providers: ['github'],
      link: 'never',
    });
    const existing = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: 'argon2id$…',
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await adapter.updateUser(existing.id, { emailVerifiedAt: NOW });

    const denied = signInWithOAuth(strict, { profile: profile(), tokens: tokens() });
    expect(await codeOf(denied)).toBe('X_UNAUTHENTICATED');
    await expect(denied).rejects.toThrow(/link: 'never'/);
    expect(await adapter.findAccount('github', '583231')).toBeNull();
    // The address stays a redactable `meta` key here too, never part of the sentence.
    const error = await denied.catch((thrown: unknown) => thrown);
    expect(isUltimateError(error) && error.cause).not.toContain('ada@example.com');
  });

  test("link: 'never' answers an UNVERIFIED address exactly as the default policy does", async () => {
    // The oracle this ordering closes: a provider that does not verify addresses is enough to ask
    // "does an account exist here?", and a distinct code, cause and `meta.email` would answer it.
    // `loginFailed()` is the one answer every credential failure gives, so the strict policy may
    // not be the one that talks.
    const strict = defineAuth({
      adapter,
      clock: frozenClock(NOW),
      providers: ['github'],
      link: 'never',
    });
    await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: 'argon2id$…',
      orgId: null,
      roles: [],
      createdAt: NOW,
    });

    const denied = signInWithOAuth(strict, {
      profile: profile({ emailVerified: false }),
      tokens: tokens(),
    });

    expect(await codeOf(denied)).toBe('X_UNAUTHENTICATED');
    const error = await denied.catch((thrown: unknown) => thrown);
    // The generic failure, not the linking one: same code, and a cause that names neither the
    // address nor the policy.
    expect(isUltimateError(error) && error.cause).not.toContain("link: 'never'");
    expect(isUltimateError(error) && error.meta?.['email']).toBeUndefined();
    expect(await adapter.findAccount('github', '583231')).toBeNull();
  });

  test("'verified-email' is the default, so an app that says nothing gets the strict rule", () => {
    expect(defineAuth({ adapter, clock: frozenClock(NOW) }).link).toBe('verified-email');
  });

  test('it refuses to take over an account that never verified its own address', async () => {
    await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: 'argon2id$…',
      orgId: null,
      roles: [],
      createdAt: NOW,
    });

    const denied = signInWithOAuth(auth, { profile: profile(), tokens: tokens() });
    expect(await codeOf(denied)).toBe('X_UNAUTHENTICATED');
    await expect(denied).rejects.toThrow(/never verified it/);
    expect(await adapter.findAccount('github', '583231')).toBeNull();

    // The address is a `meta` field a log pipeline can redact by key, never part of the sentence.
    const error = await denied.catch((thrown: unknown) => thrown);
    expect(isUltimateError(error) && error.cause).not.toContain('ada@example.com');
    expect(isUltimateError(error) && error.meta).toEqual({
      provider: 'github',
      email: 'ada@example.com',
    });
  });

  test('an unverified provider address never attaches to an existing account', async () => {
    const existing = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await adapter.updateUser(existing.id, { emailVerifiedAt: NOW });

    const denied = signInWithOAuth(auth, {
      profile: profile({ emailVerified: false }),
      tokens: tokens(),
    });
    expect(await codeOf(denied)).toBe('X_UNAUTHENTICATED');
    // Opaque on this path: the caller has proven nothing about the address.
    await expect(denied).rejects.toThrow(/did not match an account/);
  });

  test('a disabled user cannot come back in through an already-linked account', async () => {
    const user = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await adapter.updateUser(user.id, { emailVerifiedAt: NOW, disabledAt: NOW });
    // Links the account first, so the second sign-in resolves through `userForAccount`.
    await adapter.linkAccount({
      id: 'account-1',
      userId: 'user-1',
      provider: 'github',
      providerAccountId: '583231',
      accessToken: 'gho_old',
      refreshToken: null,
      expiresAt: null,
      createdAt: NOW,
    });
    expect(await codeOf(signInWithOAuth(auth, { profile: profile(), tokens: tokens() }))).toBe(
      'X_UNAUTHENTICATED',
    );
  });

  // The other half of the same rule: disabled is checked twice, once per path to a user, and
  // only the linked path was pinned. A regression in this branch re-admits a disabled account
  // through any provider it never linked.
  test('a disabled user cannot come back in through an unlinked provider either', async () => {
    const user = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await adapter.updateUser(user.id, { emailVerifiedAt: NOW, disabledAt: NOW });
    expect(await adapter.findAccount('github', '583231')).toBeNull();

    expect(await codeOf(signInWithOAuth(auth, { profile: profile(), tokens: tokens() }))).toBe(
      'X_UNAUTHENTICATED',
    );
    expect(await adapter.findAccount('github', '583231')).toBeNull();
  });

  test('an enrolled second factor still applies, and the account is linked first', async () => {
    const user = await adapter.createUser({
      id: 'user-1',
      email: 'ada@example.com',
      passwordHash: null,
      orgId: null,
      roles: [],
      createdAt: NOW,
    });
    await adapter.updateUser(user.id, { emailVerifiedAt: NOW, mfaSecret: 'JBSWY3DPEHPK3PXP' });

    expect(await codeOf(signInWithOAuth(auth, { profile: profile(), tokens: tokens() }))).toBe(
      'X_MFA_REQUIRED',
    );
    // The second factor is finished on another request; that request must find the link.
    expect((await adapter.findAccount('github', '583231'))?.userId).toBe('user-1');
    expect(await adapter.listSessions('user-1')).toEqual([]);
  });

  test('an identity with no address names the missing scope, not a wrong password', async () => {
    const denied = signInWithOAuth(auth, {
      profile: profile({ email: null, emailVerified: false }),
      tokens: tokens(),
    });
    expect(await codeOf(denied)).toBe('X_OAUTH_EXCHANGE_FAILED');
    await expect(denied).rejects.toThrow(/no email address/);
  });

  test('a provider missing from defineAuth cannot mint a session', async () => {
    const denied = signInWithOAuth(auth, {
      profile: profile({ provider: 'apple', providerAccountId: 'apple-sub' }),
      tokens: tokens(),
    });
    expect(await codeOf(denied)).toBe('X_CONFIG_INVALID');
    await expect(denied).rejects.toThrow(/defineAuth/);
  });

  test('the grant seam is applied to a user this flow creates', async () => {
    const result = await signInWithOAuth(auth, {
      profile: profile(),
      tokens: tokens(),
      grants: { roles: ['reader'], orgId: 'org-1' },
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(result.actor.roles).toEqual(['reader']);
    expect(result.actor.orgId).toBe('org-1');
    expect(result.session.ip).toBe('203.0.113.7');
  });
});
