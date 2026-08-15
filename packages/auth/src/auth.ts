// Single responsibility: the one configuration entry point and the credential flows built on
// it. The output of authentication is an `Actor` from `@ultimat3/core` — every surface
// (http, actions, jobs, MCP) authorizes on that and never on a session row, so there is one
// identity shape in the framework and `@ultimat3/policy` is the only thing that reads it.

import { type Clock, systemClock, uuid } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { AuthAdapter, AuthSession, AuthUser } from './adapter';
import { mfaRequired, sessionUnknown } from './errors';
import type { OAuthProviderId } from './oauth';
import { OAUTH_PROVIDER_IDS } from './oauth';
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
  assertAuthLimiterScope,
  createAuthLimiter,
  DEFAULT_AUTH_RATE_LIMIT,
  ipKey,
  loginFailed,
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
  provider: t.enum(['github', 'google', 'apple']),
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
  readonly mfa?: Partial<AuthMfaPolicy> | undefined;
  readonly providers?: readonly OAuthProviderId[] | undefined;
}

export interface Auth {
  readonly adapter: AuthAdapter;
  readonly clock: Clock;
  readonly sessions: SessionRuntime;
  readonly password: PasswordPolicy;
  readonly rateLimit: AuthRateLimitPolicy;
  readonly limiter: AuthLimiter;
  readonly mfa: AuthMfaPolicy;
  readonly providers: readonly OAuthProviderId[];
}

export function defineAuth(config: AuthConfigInput): Auth {
  const clock = config.clock ?? systemClock;
  const session: SessionPolicy = { ...DEFAULT_SESSION_POLICY, ...config.session };
  const password: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY, ...config.password };
  const rateLimit: AuthRateLimitPolicy = { ...DEFAULT_AUTH_RATE_LIMIT, ...config.rateLimit };
  const limiter = config.limiter ?? createAuthLimiter(clock, rateLimit);
  assertAuthLimiterScope(rateLimit, limiter);
  return Object.freeze({
    adapter: config.adapter,
    clock,
    sessions: { store: config.adapter, policy: session, clock },
    password,
    rateLimit,
    limiter,
    mfa: { issuer: config.mfa?.issuer ?? 'Ultimate', required: config.mfa?.required ?? false },
    providers: config.providers ?? OAUTH_PROVIDER_IDS,
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
  const usable = user !== null && user.disabledAt === null;
  const verification = await verifyPassword({
    hash: usable ? user.passwordHash : null,
    password: input.password,
    params: auth.password.params,
  });

  if (!verification.ok || user === null) {
    await auth.limiter.recordFailure(account);
    if (ip !== null) await auth.limiter.recordFailure(ipKey(ip));
    throw loginFailed();
  }

  await auth.limiter.recordSuccess(account);
  if (ip !== null) await auth.limiter.recordSuccess(ipKey(ip));

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
