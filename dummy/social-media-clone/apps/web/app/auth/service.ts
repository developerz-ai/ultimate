// Sign in, sign up, sign out. The rules live here; `@ultimat3/auth` (`auth.ts`) verifies the
// password, counts the failures, locks the account and keeps the session; `captcha.ts` decides
// whether a challenge is demanded; `repo.ts` reads the app's own `users`. A surface calls this and
// nothing below it.

import { login, logout, register } from '@ultimat3/auth';
import { isUltimateError, uuidV7 } from '@ultimat3/core';
import type { Actor } from '../../shared/actor';
import { CAPTCHA_AFTER_FAILURES } from '../../shared/auth-policy';
import { appAuth } from './auth';
import { ensureDemoCredentials } from './bootstrap';
import { captcha } from './captcha';
import { CaptchaFailed, CredentialsInvalid, EmailTaken, HandleTaken } from './errors';
import { insertUser, userByEmail, userByHandle, userById } from './repo';
import { actorFor } from './viewer';

/** A handle is the URL. A URL differing only in case is two URLs, so one spelling reaches the db. */
export const normalizeHandle = (handle: string): string => handle.trim().toLowerCase();

/**
 * Refusals per handle, counted per PROCESS — the captcha's trigger, nothing more. The lockout is
 * `@ultimat3/auth`'s and is counted where its limiter keeps it; this only decides when the next
 * attempt must carry a challenge. Bounded: the key is whatever a caller submitted, so an unbounded
 * map was heap any visitor could grow. The oldest handle goes first.
 */
const failures = new Map<string, number>();
const MAX_COUNTED_HANDLES = 10_000;

export const failureCount = (handle: string): number => failures.get(normalizeHandle(handle)) ?? 0;

const countFailure = (handle: string): void => {
  const count = failureCount(handle) + 1;
  // Deleted first so the handle moves to the newest end: eviction drops the coldest, never a hot one.
  failures.delete(handle);
  failures.set(handle, count);
  for (const oldest of failures.keys()) {
    if (failures.size <= MAX_COUNTED_HANDLES) break;
    failures.delete(oldest);
  }
};

export const captchaRequiredFor = (handle: string): boolean =>
  captcha().enabled && failureCount(handle) >= CAPTCHA_AFTER_FAILURES;

/** Test seam, and what a restart already does. */
export const resetFailures = (): void => failures.clear();

export interface IssuedSession {
  readonly token: string;
  readonly actor: Actor;
  readonly expiresAt: Date;
}

/** The session `login()` issued, as the actor this app resolves — the one resolver, `actorFor`. */
const issued = async (result: Awaited<ReturnType<typeof login>>): Promise<IssuedSession> => {
  const user = await userById(result.session.userId);
  if (user === null) throw new CredentialsInvalid();
  return {
    token: result.token,
    actor: await actorFor(user),
    expiresAt: result.session.absoluteExpiresAt,
  };
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
 * `login()` answers an unknown handle and a wrong password alike, after the same hash; this app
 * names that refusal `X_AUTH_CREDENTIALS_INVALID`, and the lockout reaches the caller as auth's own
 * `X_ACCOUNT_LOCKED`.
 */
export const signIn = async (input: SignInInput): Promise<IssuedSession> => {
  await ensureDemoCredentials();
  const handle = normalizeHandle(input.handle);
  if (captchaRequiredFor(handle) && !(await captcha().verify(input.captchaToken))) {
    throw new CaptchaFailed(captcha().name);
  }
  try {
    const result = await login(appAuth(), { handle, password: input.password });
    failures.delete(handle);
    return await issued(result);
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_UNAUTHENTICATED') {
      countFailure(handle);
      throw new CredentialsInvalid();
    }
    throw error;
  }
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
 *
 * The auth user is written FIRST, under the id the `users` row will carry: `register()` judges the
 * password before it writes anything, and its address is unique in `x_users` as it is in `users`.
 * Both are read here first, so the one way to leave an auth user with no `users` row is two
 * sign-ups racing for one handle — and an orphan is unreachable, since nothing resolves a handle
 * to its id.
 */
export const signUp = async (input: SignUpInput): Promise<IssuedSession> => {
  if (captcha().enabled && !(await captcha().verify(input.captchaToken))) {
    throw new CaptchaFailed(captcha().name);
  }
  const handle = normalizeHandle(input.handle);
  const email = input.email.trim().toLowerCase();
  // Checked, and then enforced again by the unique indexes behind both columns — these reads are
  // the good error messages, not the guarantee.
  if ((await userByHandle(handle)) !== null) throw new HandleTaken(handle);
  if ((await userByEmail(email)) !== null) throw new EmailTaken();

  const id = uuidV7();
  await register(appAuth(), { id, email, password: input.password });
  await insertUser({ id, handle, email, displayName: input.displayName.trim() });
  // A brand-new account has no friends and no blocks, but the actor is still built by the one
  // resolver — a hand-written `new Set()` here would be a second definition of what an actor is.
  return await issued(await login(appAuth(), { handle, password: input.password }));
};

/**
 * Revoke the session this token names. Unknown or already-revoked is a no-op, not an error: a
 * second sign-out click, or a stale tab, must not produce a 500.
 */
export const signOut = async (token: string | null): Promise<boolean> => {
  if (token === null || token.length === 0) return false;
  return await logout(appAuth(), token);
};
