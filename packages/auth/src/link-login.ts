// Single responsibility: `signInWithLink` — a mailed link as a sign-in door. The link is consumed
// (single-use, expiring, hashed at rest: `consumeVerification`), its address resolved to a user,
// and the answer is the `LoginResult` every other door gives — or `X_MFA_REQUIRED` and no session
// when a second factor is enrolled. One call, so the second factor is not the caller's to forget.

import { ConfigInvalidError, renderFixLiteral, uuidV7 } from '@ultimat3/core';
import type { AuthUser } from './adapter';
import type { Auth, LoginResult } from './auth';
import { normaliseEmail } from './email';
import { AuthError, authWriteFailed } from './errors';
import { mfaChallengeRequired } from './mfa-challenge';
import { resolveActor } from './policy-bridge';
import { createSession, sessionCookie } from './session';
import { verificationPurpose } from './verification-purposes';
import { consumeVerification, VERIFICATION_PURPOSES, type VerificationPurpose } from './verify';

/** What a proven address with no account becomes. Business convention, so the app states it. */
export interface LinkSignUp {
  /** The user's id, when the app already chose one — as `register(auth, { id })` takes it. */
  readonly id?: string | undefined;
  readonly orgId?: string | null | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly externalId?: string | null | undefined;
}

export interface LinkSignInInput {
  /**
   * The purpose the link was issued under: one the app declared for signing in
   * (`defineVerificationPurpose`). Never `'email-verify'` or `'password-reset'` — a token mailed
   * to do one job is not a session.
   */
  readonly purpose: VerificationPurpose;
  /** The address the link was mailed to. */
  readonly identifier: string;
  readonly token: string;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  /**
   * Declared: an address no account holds becomes a verified, passwordless one. Absent: it is
   * refused. Never applied to an account that exists.
   */
  readonly signUp?: LinkSignUp | undefined;
}

/**
 * One answer for "no account" and "disabled account", carrying nothing: the caller proved an
 * inbox, which is not a reason to describe the account behind it.
 */
const linkSignInRefused = (purpose: string): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause: 'the sign-in link was valid, and its address has no account that may sign in',
    fix: `signInWithLink(auth, { purpose: ${renderFixLiteral(purpose, "'<purpose>'")}, identifier, token, signUp: {} })   // only where a proven address with no account should become one — a disabled account stays refused`,
  });

/**
 * An account holds the address and never proved it, so whoever registered it chose its password.
 * Signing the inbox's owner into that account hands them a session somebody else can also open.
 * Named, because this caller owns the address — the rule `oauthAccountNotLinked` follows.
 */
const linkAccountUnverified = (): AuthError =>
  new AuthError({
    code: 'X_UNAUTHENTICATED',
    cause:
      'an account holds this address but never verified it, so a sign-in link may not claim it',
    fix: 'await emailVerification.issue(runtime, { identifier: email, locale })   // the account confirms that link (emailVerification.consume, then updateUser(id, { emailVerifiedAt })), then signs in by link',
  });

/** Before the store is asked, so a refused purpose leaves its token live for its own job. */
function assertSignInPurpose(name: string): void {
  if ((VERIFICATION_PURPOSES as readonly string[]).includes(name)) {
    throw new ConfigInvalidError({
      cause: `signInWithLink() was given the built-in purpose '${name}', whose token is mailed to do that one job and is not a sign-in credential`,
      fix: "defineVerificationPurpose({ name: 'sign-in', template: 'auth.sign-in', ttlMs: 15 * 60 * 1000 })   // a purpose of its own, then signInWithLink(auth, { purpose: 'sign-in', identifier, token })",
      meta: { purpose: name },
    });
  }
  // The stored identifier is looked up as `x_users.email`, so it must be keyed the way that is.
  if (verificationPurpose(name).identifier !== normaliseEmail) {
    throw new ConfigInvalidError({
      cause: `the verification purpose ${renderFixLiteral(name, "'<purpose>'")} declares its own identifier, so what its link proves is not known to be an account's address`,
      fix: `defineVerificationPurpose({ name: ${renderFixLiteral(name, "'<purpose>'")}, template, ttlMs })   // no identifier: — the default keys on the address, as x_users.email is`,
      meta: { purpose: name },
    });
  }
}

async function signUpWith(auth: Auth, email: string, signUp: LinkSignUp): Promise<AuthUser> {
  const created = await auth.adapter.createUser({
    id: signUp.id ?? uuidV7(auth.clock),
    email,
    // No password, and never a random one: a hash nobody knows the input to is still a
    // credential a reset flow could hand over.
    passwordHash: null,
    orgId: signUp.orgId ?? null,
    roles: signUp.roles ?? [],
    scopes: signUp.scopes ?? [],
    externalId: signUp.externalId ?? null,
    createdAt: auth.clock.now(),
  });
  // `CreateUserInput` has no `emailVerifiedAt`: the stamp is a second write, and a row that says
  // unverified would be refused by this same door on the next link. Fail closed.
  const stamped = await auth.adapter.updateUser(created.id, { emailVerifiedAt: auth.clock.now() });
  if (stamped === null) throw authWriteFailed('updateUser', 'x_users');
  return stamped;
}

/**
 * A consumed link → a session, or the second factor's challenge.
 *
 * The link is spent FIRST, in the store's one atomic step: every refusal below this line has
 * already used it, so a link is good for one attempt whatever the attempt ends in. With a second
 * factor enrolled the answer is `X_MFA_REQUIRED` carrying the sealed challenge `completeMfa`
 * takes; no session row is written, and a fresh link never clears the count of wrong codes.
 */
export async function signInWithLink(auth: Auth, input: LinkSignInInput): Promise<LoginResult> {
  assertSignInPurpose(input.purpose);
  const record = await consumeVerification(
    { store: auth.adapter, clock: auth.clock },
    { purpose: input.purpose, identifier: input.identifier, token: input.token },
  );
  const email = normaliseEmail(record.identifier);
  const existing = await auth.adapter.findUserByEmail(email);
  if (existing === null && input.signUp === undefined) throw linkSignInRefused(input.purpose);
  if (existing !== null && existing.disabledAt !== null) throw linkSignInRefused(input.purpose);
  if (existing !== null && existing.emailVerifiedAt === null) throw linkAccountUnverified();
  const user = existing ?? (await signUpWith(auth, email, input.signUp ?? {}));

  // The inbox is proven, the second factor is not: the user's rule, whichever door they used.
  if (user.mfaSecret !== null) throw await mfaChallengeRequired(auth, user.id);

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
