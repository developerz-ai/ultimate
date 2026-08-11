// Sign in, sign up, sign out. The rules live here; `repo.ts` asks the database, `password.ts`
// hashes, `captcha.ts` decides whether a challenge is demanded. A surface calls this and nothing
// below it.

import type { Actor } from '../../shared/actor';
import { CAPTCHA_AFTER_FAILURES } from '../../shared/auth-policy';
import { hashToken, newSessionToken, SESSION_TTL_MS } from '../../shared/session';
import { ensureDemoCredentials } from './bootstrap';
import { captcha } from './captcha';
import { CaptchaFailed, CredentialsInvalid, HandleTaken } from './errors';
import { assertPasswordStrength, hashPassword, verifyPassword } from './password';
import {
  credentialFor,
  deleteSession,
  insertSession,
  insertUser,
  putCredential,
  sessionByTokenHash,
  userByHandle,
} from './repo';
import { actorFor } from './viewer';

/** A handle is the URL. A URL differing only in case is two URLs, so one spelling reaches the db. */
export const normalizeHandle = (handle: string): string => handle.trim().toLowerCase();

/**
 * Refusals per handle, counted per PROCESS and in memory.
 *
 * Honest for a one-node demo and wrong for a fleet: three web replicas give an attacker three
 * times the budget before `CAPTCHA_AFTER_FAILURES` bites. The fix is the shared cache tier
 * (`config.cache` in `app.config.ts`), keyed by handle — named here rather than pretended away.
 */
const failures = new Map<string, number>();

export const failureCount = (handle: string): number => failures.get(normalizeHandle(handle)) ?? 0;

export const captchaRequiredFor = (handle: string): boolean =>
  captcha().enabled && failureCount(handle) >= CAPTCHA_AFTER_FAILURES;

/** Test seam, and what a restart already does. */
export const resetFailures = (): void => failures.clear();

/**
 * A real argon2id hash of a value nobody types, verified against whenever the handle is unknown.
 *
 * Without it, "no such handle" returns in microseconds and "wrong password" returns in ~40ms, and
 * the clock tells an attacker which handles exist — the enumeration oracle
 * `X_AUTH_CREDENTIALS_INVALID` exists to close. Computed once, lazily, because it costs a hash.
 */
let decoy: Promise<string> | undefined;
const decoyHash = (): Promise<string> => {
  decoy ??= hashPassword('not-a-password-for-any-account');
  return decoy;
};

export interface IssuedSession {
  readonly token: string;
  readonly actor: Actor;
  readonly expiresAt: Date;
}

const issue = async (
  user: { readonly id: string },
  actor: Actor,
  now: Date,
): Promise<IssuedSession> => {
  const token = newSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  // The token itself is never stored. What lands in the row is its SHA-256, so a dumped
  // `sessions` table is a list of useless digests rather than a drawer of working cookies.
  await insertSession({ userId: user.id, tokenHash: hashToken(token), expiresAt });
  return { token, actor, expiresAt };
};

export interface SignInInput {
  readonly handle: string;
  readonly password: string;
  /** The widget's answer, or null when no challenge was rendered. */
  readonly captchaToken: string | null;
}

/**
 * Sign in, or refuse with one code for every reason.
 *
 * The captcha is demanded BEFORE the password is checked, and only after this handle has been
 * refused `CAPTCHA_AFTER_FAILURES` times: a challenge on the first attempt is a tax on every
 * honest sign-in, and a challenge checked after the password is a challenge an attacker skips.
 */
export const signIn = async (input: SignInInput, now = new Date()): Promise<IssuedSession> => {
  await ensureDemoCredentials();
  const handle = normalizeHandle(input.handle);
  if (captchaRequiredFor(handle) && !(await captcha().verify(input.captchaToken))) {
    throw new CaptchaFailed(captcha().name);
  }

  const user = await userByHandle(handle);
  const credential = user === null ? null : await credentialFor(user.id);
  // Always a real verify, even with nothing to verify against. See `decoyHash`.
  const ok = await verifyPassword(input.password, credential?.passwordHash ?? (await decoyHash()));
  if (!ok || user === null) {
    failures.set(handle, failureCount(handle) + 1);
    throw new CredentialsInvalid();
  }

  failures.delete(handle);
  return await issue(user, await actorFor(user), now);
};

export interface SignUpInput {
  readonly handle: string;
  readonly displayName: string;
  readonly email: string;
  readonly password: string;
  readonly captchaToken: string | null;
}

/**
 * Register, and sign the new account in.
 *
 * Every sign-up is challenged when a verifier is configured — unlike sign-in there is no prior
 * failure to count, and account creation is the endpoint a bot actually wants.
 */
export const signUp = async (input: SignUpInput, now = new Date()): Promise<IssuedSession> => {
  if (captcha().enabled && !(await captcha().verify(input.captchaToken))) {
    throw new CaptchaFailed(captcha().name);
  }
  assertPasswordStrength(input.password);

  const handle = normalizeHandle(input.handle);
  // Checked, and then enforced again by the unique index behind `users.handle` — this read is the
  // good error message, not the guarantee.
  if ((await userByHandle(handle)) !== null) throw new HandleTaken(handle);

  const user = await insertUser({
    handle,
    email: input.email.trim().toLowerCase(),
    displayName: input.displayName.trim(),
  });
  await putCredential(user.id, await hashPassword(input.password));
  // A brand-new account has no friends and no blocks, but the actor is still built by the one
  // resolver — a hand-written `new Set()` here would be a second definition of what an actor is.
  return await issue(user, await actorFor(user), now);
};

/**
 * Revoke the session this token names. Unknown or already-revoked is a no-op, not an error: a
 * second sign-out click, or a stale tab, must not produce a 500.
 */
export const signOut = async (token: string | null): Promise<boolean> => {
  if (token === null || token.length === 0) return false;
  const session = await sessionByTokenHash(hashToken(token));
  if (session === null) return false;
  await deleteSession(session.id);
  return true;
};
