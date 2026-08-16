// Single responsibility: the last leg — a verified provider identity becomes the same
// `LoginResult` a password login produces. One session shape, one `Actor`, one MFA rule, no
// matter which door the user came through. `completeOAuthLogin` is the blessed entry point;
// the three steps under it are exported because a custom flow needs the seams, not a second path.

import { ConfigInvalidError, logger, uuid } from '@ultimat3/core';
import type { AuthAccount, AuthUser } from './adapter';
import type { Auth, LoginResult } from './auth';
import {
  authWriteFailed,
  emailVerifiedNotStored,
  mfaRequired,
  oauthAccountNotLinked,
  oauthExchangeFailed,
  oauthLinkingDisabled,
  restartAt,
} from './errors';
import type { OAuthCallback, OAuthHandshake } from './oauth';
import {
  exchangeOAuthCode,
  type OAuthClientCredentials,
  type OAuthFetch,
  type OAuthTokens,
  oauthCredentials,
} from './oauth-exchange';
import { type OAuthProfile, oauthProfile } from './oauth-profile';
import { resolveActor } from './policy-bridge';
import { loginFailed } from './rate-limit';
import { createSession, sessionCookie } from './session';

/**
 * What the IdP's answer entitles this identity to, in the app's own vocabulary. Which group maps
 * to which role is business convention and never ships (axiom 8) — this is the seam it arrives
 * through, and every field is independently optional so a seam that only knows the org says only
 * that.
 */
export interface OAuthGrants {
  readonly orgId?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  /**
   * The IdP's own stable id for this person, if the app has one. Deliberately NOT derived from
   * `profile.providerAccountId`: `x_users.external_id` is unique across the table, and two
   * different OPs are free to issue the same `sub`, so auto-filling it would make one tenant's
   * google login collide with another's okta login. The app knows which id its provisioning
   * system uses; the framework does not.
   */
  readonly externalId?: string | null | undefined;
}

/** Called once per callback, after the profile is proven and before the session is minted. */
export type ResolveOAuthGrants = (profile: OAuthProfile) => Promise<OAuthGrants> | OAuthGrants;

export interface OAuthSignInInput {
  readonly profile: OAuthProfile;
  readonly tokens: OAuthTokens;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  /**
   * Authoritative on EVERY login, not only the first. The IdP is the source of truth for who is
   * in which group, so a member removed from a group there has to lose the role here on their
   * next sign-in — an apply-once-at-creation rule made "revoke in the IdP" a no-op, and left the
   * first-time user with `roles: []`, `orgId: null` and an actor every `can()` denies.
   *
   * Absent means "the app has no opinion": the stored row is left exactly as it is.
   */
  readonly grants?: OAuthGrants | undefined;
}

async function userForAccount(auth: Auth, account: AuthAccount): Promise<AuthUser> {
  const user = await auth.adapter.findUserById(account.userId);
  if (user === null || user.disabledAt !== null) throw loginFailed();
  return user;
}

/**
 * The grant seam applied to a row that already exists. Only the fields the seam actually returned
 * are written, and only when they differ — an unconditional `updateUser` would make every SSO
 * login a write, which is the same mistake `verifySession` used to make on every request.
 */
async function applyGrants(auth: Auth, user: AuthUser, grants: OAuthGrants): Promise<AuthUser> {
  const same = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
    a === undefined || (a.length === b.length && a.every((one, index) => one === b[index]));
  const unchanged = (declared: string | null | undefined, stored: string | null): boolean =>
    declared === undefined || (declared ?? null) === stored;
  if (
    unchanged(grants.orgId, user.orgId) &&
    unchanged(grants.externalId, user.externalId) &&
    same(grants.roles, user.roles) &&
    same(grants.scopes, user.scopes)
  ) {
    return user;
  }
  const patched = await auth.adapter.updateUser(user.id, {
    ...(grants.orgId === undefined ? {} : { orgId: grants.orgId ?? null }),
    ...(grants.roles === undefined ? {} : { roles: grants.roles }),
    ...(grants.scopes === undefined ? {} : { scopes: grants.scopes }),
    ...(grants.externalId === undefined ? {} : { externalId: grants.externalId ?? null }),
  });
  // Failing closed rather than signing in with the stale row: the whole point of the seam is that
  // the session about to be minted carries what the IdP says today.
  if (patched === null) throw authWriteFailed('updateUser', 'x_users');
  return patched;
}

async function createUserFor(auth: Auth, input: OAuthSignInInput): Promise<AuthUser> {
  const email = input.profile.email;
  // The provider authenticated somebody and told us no address. There is nothing to create an
  // account from, and saying "wrong password" here would send the developer hunting the wrong bug.
  if (email === null) {
    throw oauthExchangeFailed({
      provider: input.profile.provider,
      stage: 'userinfo',
      detail: 'the provider returned an identity with no email address',
      fix: `request the email scope for ${input.profile.provider} in beginOAuth(), then ${restartAt(input.profile.provider)}`,
    });
  }
  const grants = input.grants ?? {};
  if ((grants.roles ?? []).length === 0 && (grants.orgId ?? null) === null) {
    // Not an error — an app may genuinely want a roleless account until somebody approves it —
    // but silent is how "SSO works and the user can do nothing" survives to production. Every
    // `can()` denies a roleless actor, and a tenant-scoped read throws before the query is built.
    logger.warn('auth.oauth.user_created_without_grants', {
      provider: input.profile.provider,
      seam: 'oauthLogin(auth, { resolveGrants })',
    });
  }
  const created = await auth.adapter.createUser({
    id: uuid(auth.clock),
    email,
    // An OAuth-only account has no password to store, and must never be given a random one:
    // a hash nobody knows the input to is still a credential a reset flow could hand over.
    passwordHash: null,
    orgId: grants.orgId ?? null,
    roles: grants.roles ?? [],
    scopes: grants.scopes ?? [],
    externalId: grants.externalId ?? null,
    createdAt: auth.clock.now(),
  });
  if (!input.profile.emailVerified) return created;
  // `CreateUserInput` has no `emailVerifiedAt`, so the stamp is a required second write. Returning
  // `created` when it does not land would sign in a user whose row says unverified — and the next
  // login through this same provider would then refuse to link it at all.
  const stamped = await auth.adapter.updateUser(created.id, { emailVerifiedAt: auth.clock.now() });
  if (stamped === null) throw emailVerifiedNotStored(input.profile.provider, created.id);
  return stamped;
}

/**
 * Resolve the identity to a user: an already-linked account first, then an existing account
 * with the same address, then a fresh user.
 *
 * An address alone is not proof of ownership on either side. Attaching a provider identity to a
 * local account that never verified its own email hands the login to whoever registered that
 * address first, so both halves must have proven it before they are treated as one person.
 *
 * `auth.link` is the app's one say in that. `'never'` skips the address step entirely and refuses
 * a collision; `'verified-email'` — the default — is the both-halves-proven rule below.
 */
async function resolveUser(
  auth: Auth,
  input: OAuthSignInInput,
  linked: AuthAccount | null,
): Promise<AuthUser> {
  const { provider, email, emailVerified } = input.profile;
  if (linked !== null) return await userForAccount(auth, linked);

  if (email === null) return await createUserFor(auth, input);
  const existing = await auth.adapter.findUserByEmail(email);
  if (existing === null) return await createUserFor(auth, input);
  if (existing.disabledAt !== null) throw loginFailed();
  // The provider did not vouch for the address, so nothing here proves the two are one person.
  if (!emailVerified) throw loginFailed();
  // Only past that line is the caller known to own the address, which is what makes naming the
  // collision safe. Refusing `'never'` any earlier answered an UNVERIFIED provider address with a
  // distinct code and a `meta.email` where `'verified-email'` answers `loginFailed()` — so the
  // strict policy confirmed an account exists at an address its caller never proved. `disabledAt`
  // above is generic and reveals nothing, which is why it can be asked first.
  if (auth.link === 'never') throw oauthLinkingDisabled(provider, email);
  // It did vouch, and the local account never did: say so, because this caller owns the address.
  if (existing.emailVerifiedAt === null) throw oauthAccountNotLinked(provider, email);
  return existing;
}

function accountFor(auth: Auth, user: AuthUser, input: OAuthSignInInput): AuthAccount {
  return {
    id: uuid(auth.clock),
    userId: user.id,
    provider: input.profile.provider,
    providerAccountId: input.profile.providerAccountId,
    accessToken: input.tokens.accessToken,
    refreshToken: input.tokens.refreshToken,
    expiresAt: input.tokens.expiresAt,
    createdAt: auth.clock.now(),
  };
}

/**
 * Mints the session for an identity the provider has already proven. MFA still applies: an
 * enrolled second factor is the user's rule, not the password path's rule.
 */
export async function signInWithOAuth(auth: Auth, input: OAuthSignInInput): Promise<LoginResult> {
  const provider = input.profile.provider;
  if (!auth.providers.includes(provider)) {
    throw new ConfigInvalidError({
      cause: `${provider} is not in defineAuth({ providers }), so a ${provider} identity cannot sign in`,
      fix: `add '${provider}' to defineAuth({ providers: [...] }), or stop offering the ${provider} button`,
      meta: { provider, enabled: [...auth.providers] },
    });
  }

  const linked = await auth.adapter.findAccount(provider, input.profile.providerAccountId);
  const resolved = await resolveUser(auth, input, linked);
  const user =
    input.grants === undefined ? resolved : await applyGrants(auth, resolved, input.grants);
  // Linked before the MFA gate on purpose: the second factor is finished on another request,
  // and that request must find the identity already attached. A re-link refreshes the tokens
  // and keeps the row's own identity — the provider account never changes hands.
  const account = accountFor(auth, user, input);
  await auth.adapter.linkAccount(
    linked === null ? account : { ...account, id: linked.id, createdAt: linked.createdAt },
  );

  if (user.mfaSecret !== null) throw mfaRequired(user.id);

  const issued = await createSession(auth.sessions, {
    userId: user.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent,
    mfaSatisfied: true,
  });
  return {
    actor: resolveActor({ kind: 'user', user, session: issued.session }),
    session: issued.session,
    token: issued.token,
    cookie: sessionCookie(issued.token, auth.sessions.policy),
  };
}

export interface CompleteOAuthLoginInput {
  readonly handshake: OAuthHandshake;
  readonly callback: OAuthCallback;
  /** Defaults to the two env vars named in the provider table. */
  readonly credentials?: OAuthClientCredentials | undefined;
  /** Injected in tests; production uses the global. */
  readonly fetch?: OAuthFetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  /** The app's grant seam. Called once, after the profile is proven. */
  readonly resolveGrants?: ResolveOAuthGrants | undefined;
}

/** Callback → session, in one call: exchange, identify, sign in. */
export async function completeOAuthLogin(
  auth: Auth,
  input: CompleteOAuthLoginInput,
): Promise<LoginResult> {
  const provider = input.handshake.provider;
  const tokens = await exchangeOAuthCode(input.handshake, input.callback, {
    credentials: input.credentials ?? oauthCredentials(provider),
    clock: auth.clock,
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const profile = await oauthProfile(provider, tokens, {
    fetch: input.fetch,
    timeoutMs: input.timeoutMs,
  });
  const grants = input.resolveGrants === undefined ? undefined : await input.resolveGrants(profile);
  return await signInWithOAuth(auth, {
    profile,
    tokens,
    ip: input.ip,
    userAgent: input.userAgent,
    ...(grants === undefined ? {} : { grants }),
  });
}
