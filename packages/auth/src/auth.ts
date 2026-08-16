// Single responsibility: the one configuration entry point and the credential flows built on
// it. The output of authentication is an `Actor` from `@ultimat3/core` — every surface
// (http, actions, jobs, MCP) authorizes on that and never on a session row, so there is one
// identity shape in the framework and `@ultimat3/policy` is the only thing that reads it.

import { type Clock, systemClock, uuid } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { AuthAdapter, AuthSession, AuthUser } from './adapter';
import { mfaRequired, sessionUnknown } from './errors';
import type { OAuthProviderId } from './oauth';
import { oauthProviderIds } from './oauth-registry';
import {
  checkPasswordStrength,
  DEFAULT_PASSWORD_POLICY,
  hashPassword,
  type PasswordPolicy,
  verifyPassword,
} from './password';
import { type PolicyActor, resolveActor } from './policy-bridge';
import {
  type AuthLimiter,
  type AuthRateLimitPolicy,
  accountKey,
  assertAuthLimiterPolicy,
  createAuthLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  ipKey,
  loginFailed,
  orgKey,
  orgRateLimit,
} from './rate-limit';
import {
  createSession,
  DEFAULT_SESSION_POLICY,
  parseSessionToken,
  type SessionPolicy,
  type SessionRuntime,
  sessionCookie,
  verifySession,
} from './session';

// The projections safe to hand to a client or an MCP tool: no password hash, no TOTP secret,
// no token hash. The private columns live in `adapter.ts` and never leave the server.
export const UserSchema = t.object({
  id: t.uuid,
  email: t.email,
  emailVerifiedAt: t.optional(t.date),
  orgId: t.optional(t.uuid),
  roles: t.array(t.string),
  permissions: t.array(t.string),
  scopes: t.array(t.string),
  externalId: t.optional(t.string),
  mfaEnrolled: t.boolean,
  createdAt: t.date,
});

export const SessionSchema = t.object({
  id: t.string,
  userId: t.uuid,
  createdAt: t.date,
  absoluteExpiresAt: t.date,
  lastSeenAt: t.date,
  ip: t.optional(t.string),
  userAgent: t.optional(t.string),
  mfaSatisfied: t.boolean,
});

export const AccountSchema = t.object({
  id: t.uuid,
  userId: t.uuid,
  // Any registered provider id, not the three built-ins: an app that registers its own OP has
  // account rows carrying that id, and an enum of three would refuse to parse its own data.
  provider: t.string,
  providerAccountId: t.string,
  expiresAt: t.optional(t.date),
  createdAt: t.date,
});

export const VerificationSchema = t.object({
  id: t.string,
  purpose: t.enum(['email-verify', 'password-reset']),
  identifier: t.email,
  expiresAt: t.date,
  consumedAt: t.optional(t.date),
  createdAt: t.date,
});

/**
 * When a provider identity with no linked account is allowed to become an EXISTING local user.
 *
 * There are two values and there is deliberately no third. The dangerous one an app would reach
 * for — "link on whatever address the provider sent" — is not spelled here at all, because a
 * provider that does not verify addresses turns it into account takeover: register the victim's
 * address at a sloppy provider, press the button, inherit the account. Unrepresentable beats
 * explicit, the same way `PkcePair.method` is the literal `'S256'` and never `'plain'`.
 *
 * | value | a provider identity becomes an existing user when |
 * |---|---|
 * | `'verified-email'` (default) | the provider asserted the address verified AND that user had verified it too |
 * | `'never'` | never — an address collision is refused and the caller signs in with their own credentials |
 *
 * An app that genuinely wants something else composes it: wrap `signInWithOAuth` and resolve the
 * user yourself. That is the seam, and it keeps the framework from shipping the loose default.
 */
export type OAuthLinkPolicy = 'verified-email' | 'never';

export interface AuthMfaPolicy {
  /** Shown in the authenticator app. Usually the product name. */
  readonly issuer: string;
  readonly required: boolean;
}

export interface AuthConfigInput {
  readonly adapter: AuthAdapter;
  readonly clock?: Clock | undefined;
  readonly session?: Partial<SessionPolicy> | undefined;
  readonly password?: Partial<PasswordPolicy> | undefined;
  readonly rateLimit?: Partial<AuthRateLimitPolicy> | undefined;
  /**
   * Where failed attempts are counted. Omitted means `createAuthLimiter`, which is one process'
   * worth of state — correct for dev and tests, and `maxAttempts × N` for N replicas. An app that
   * runs more than one declares `rateLimit.scope: 'shared'` and passes a limiter that says the
   * same, or `defineAuth` refuses here rather than at 3am on the first spray.
   */
  readonly limiter?: AuthLimiter | undefined;
  /**
   * Where the per-TENANT counters live. Same rule as `limiter`, and a separate instance because
   * it enforces a separate `maxAttempts` — `rateLimit.orgMaxAttempts`, which a whole org shares.
   */
  readonly orgLimiter?: AuthLimiter | undefined;
  readonly mfa?: Partial<AuthMfaPolicy> | undefined;
  readonly providers?: readonly OAuthProviderId[] | undefined;
  /** Defaults to `'verified-email'` — both halves proven. See `OAuthLinkPolicy`. */
  readonly link?: OAuthLinkPolicy | undefined;
}

export interface Auth {
  readonly adapter: AuthAdapter;
  readonly clock: Clock;
  readonly sessions: SessionRuntime;
  readonly password: PasswordPolicy;
  readonly rateLimit: AuthRateLimitPolicy;
  readonly limiter: AuthLimiter;
  /** The tenant bucket's own policy — `rateLimit` with `orgMaxAttempts` as its `maxAttempts`. */
  readonly orgRateLimit: AuthRateLimitPolicy;
  readonly orgLimiter: AuthLimiter;
  readonly mfa: AuthMfaPolicy;
  readonly providers: readonly OAuthProviderId[];
  readonly link: OAuthLinkPolicy;
}

export function defineAuth(config: AuthConfigInput): Auth {
  const clock = config.clock ?? systemClock;
  const session: SessionPolicy = { ...DEFAULT_SESSION_POLICY, ...config.session };
  const password: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY, ...config.password };
  const rateLimit: AuthRateLimitPolicy = { ...DEFAULT_AUTH_RATE_LIMIT, ...config.rateLimit };
  const limiter = config.limiter ?? createAuthLimiter(clock, rateLimit);
  assertAuthLimiterPolicy(rateLimit, limiter);
  // The tenant bucket is a noisy-neighbour cap, not a credential-guessing allowance, so an app
  // that declares `scope: 'shared'` for its LOCKOUT is not also required to ship a shared limiter
  // for this one — per replica it approximates to `orgMaxAttempts × replicas`, which is a
  // throughput ceiling and discloses nothing. An INJECTED org limiter is still compared, because
  // then the app has made a claim about what it enforces and `Auth.orgRateLimit` reports it.
  const orgLimits = orgRateLimit(rateLimit);
  const orgLimiter = config.orgLimiter ?? createAuthLimiter(clock, orgLimits);
  if (config.orgLimiter !== undefined) assertAuthLimiterPolicy(orgLimits, config.orgLimiter);
  return Object.freeze({
    adapter: config.adapter,
    clock,
    sessions: { store: config.adapter, policy: session, clock },
    password,
    rateLimit,
    limiter,
    // What the limiter in use actually enforces, not the derivation — the two differ in `scope`
    // exactly when the app declared 'shared' and left this limiter to the default.
    orgRateLimit: orgLimiter.policy,
    orgLimiter,
    mfa: { issuer: config.mfa?.issuer ?? 'Ultimate', required: config.mfa?.required ?? false },
    providers: config.providers ?? oauthProviderIds(),
    link: config.link ?? 'verified-email',
  });
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly orgId?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
}

/** Strength is checked before the KDF runs — a weak password should not cost 100ms to reject. */
export async function register(auth: Auth, input: RegisterInput): Promise<AuthUser> {
  checkPasswordStrength(input.password, { policy: auth.password });
  return await auth.adapter.createUser({
    id: uuid(auth.clock),
    email: input.email.trim().toLowerCase(),
    passwordHash: await hashPassword(input.password, auth.password.params),
    orgId: input.orgId ?? null,
    roles: input.roles ?? [],
    createdAt: auth.clock.now(),
  });
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
}

export interface LoginResult {
  readonly actor: PolicyActor;
  readonly session: AuthSession;
  /** Shown once — put it in the cookie below and forget it. */
  readonly token: string;
  readonly cookie: string;
}

/**
 * Every failure path here throws `loginFailed()` — unknown address, wrong password and
 * disabled account are indistinguishable in both message and duration. The only paths that
 * throw something else are lockout (before any work) and MFA (after the password is proven).
 */
export async function login(auth: Auth, input: LoginInput): Promise<LoginResult> {
  const account = accountKey(input.email);
  const ip = input.ip ?? null;
  await auth.limiter.assertAllowed(account);
  if (ip !== null) await auth.limiter.assertAllowed(ipKey(ip));

  const user = await auth.adapter.findUserByEmail(input.email.trim().toLowerCase());
  // The tenant bucket can only be consulted once the address resolves to an org, which is still
  // before the KDF runs — the expensive half of this function — so it costs one map lookup and
  // caps a spray that per-IP and per-account buckets both let through.
  const org = user?.orgId ?? null;
  if (org !== null) await auth.orgLimiter.assertAllowed(orgKey(org));

  const usable = user !== null && user.disabledAt === null;
  const verification = await verifyPassword({
    hash: usable ? user.passwordHash : null,
    password: input.password,
    params: auth.password.params,
  });

  if (!verification.ok || user === null) {
    await auth.limiter.recordFailure(account);
    if (ip !== null) await auth.limiter.recordFailure(ipKey(ip));
    if (org !== null) await auth.orgLimiter.recordFailure(orgKey(org));
    throw loginFailed();
  }

  await auth.limiter.recordSuccess(account);
  if (ip !== null) await auth.limiter.recordSuccess(ipKey(ip));
  // No `recordSuccess` on the tenant bucket, and that asymmetry is the point: one member signing
  // in successfully must not clear the count a broken integration is running up beside them, or
  // the tenant cap is cleared by exactly the traffic that proves the tenant is still in use.

  // Parameters were raised since this hash was written: upgrade it now, while we hold the
  // plaintext. This is the only moment it is possible without asking the user for anything.
  if (verification.needsRehash) {
    await auth.adapter.updateUser(user.id, {
      passwordHash: await hashPassword(input.password, auth.password.params),
    });
  }

  // Password proven, second factor not. The client finishes at POST /auth/mfa/verify, which is
  // what mints the session — no half-authenticated session is written here.
  if (user.mfaSecret !== null) throw mfaRequired(user.id);

  const issued = await createSession(auth.sessions, {
    userId: user.id,
    ip,
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

/**
 * The http auth stage. A missing cookie is anonymous, not an error — `meta.auth` decides
 * whether anonymous is acceptable, and it does that in one place.
 */
export async function authenticate(auth: Auth, token: string | null): Promise<PolicyActor> {
  if (token === null || token.length === 0) return resolveActor({ kind: 'anonymous' });
  const session = await verifySession(auth.sessions, token);
  const user = await auth.adapter.findUserById(session.userId);
  if (user === null || user.disabledAt !== null) {
    await auth.adapter.deleteSession(session.id);
    throw sessionUnknown();
  }
  return resolveActor({ kind: 'user', user, session });
}

export async function logout(auth: Auth, token: string): Promise<boolean> {
  const parsed = parseSessionToken(token);
  if (parsed === null) return false;
  return await auth.adapter.deleteSession(parsed.id);
}
