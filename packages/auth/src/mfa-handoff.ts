// Single responsibility: how the built-in sign-in routes hand an `X_MFA_REQUIRED` challenge to the
// app's own second-factor page — the `mfaPath` they redirect to, the one cookie the challenge rides
// in, and its reader. A cookie and never the URL or a body: a URL is in a log, a history and a
// `Referer`; `__Host-` + `HttpOnly` is read by this origin's server and nothing else.

import {
  ConfigInvalidError,
  isUltimateError,
  readCookie,
  renderCauseValue,
  serializeSetCookie,
} from '@ultimat3/core';
import { AuthError } from './errors';
import { MFA_CHALLENGE_TTL_MS } from './mfa-challenge';
import type { RequestLike } from './session';

/** `__Host-`: Secure, `Path=/`, no `Domain` — a sibling subdomain can neither read nor plant it. */
export const MFA_CHALLENGE_COOKIE = '__Host-x_mfa';

/** The sign-in front door a `fix:` line names: the call an operator edits. */
export type SignInFactory = 'oauthLogin' | 'identityProviderRoutes';

const CALL: Readonly<Record<SignInFactory, string>> = {
  oauthLogin: "oauthLogin(auth, { mfaPath: '/sign-in/mfa' })",
  identityProviderRoutes: "identityProviderRoutes(auth, { providers, mfaPath: '/sign-in/mfa' })",
};

const PAGE =
  "on that page: completeMfa(auth, readMfaChallenge(request) ?? '', code), then send result.cookie and clearMfaChallengeCookie()";

/**
 * `mfaPath`, refused at the call when a browser could read it as anywhere but a path on this
 * origin: `//host`, `/\host` and a scheme are all "another site" to a `Location` header.
 */
export function mfaLandingPath(factory: SignInFactory, path: string): string {
  const local =
    typeof path === 'string' &&
    path.startsWith('/') &&
    !/[\\?#]/.test(path) &&
    // `//host` resolves to another origin, and its pathname is no longer the whole input.
    new URL(path, 'https://x.invalid').pathname === path;
  if (!local) {
    throw new ConfigInvalidError({
      cause: `${factory}({ mfaPath: ${renderCauseValue(path)} }) is not a normalised absolute path on this origin, so the MFA challenge cookie would be followed by a redirect somewhere else`,
      fix: `${CALL[factory]}  // one absolute path: no host, query, fragment, backslash or ./.. segment`,
    });
  }
  return path;
}

/** The sealed challenge of an `X_MFA_REQUIRED`, or `null` for every other throw. */
export function mfaChallengeOf(error: unknown): string | null {
  if (!isUltimateError(error) || error.code !== 'X_MFA_REQUIRED') return null;
  const challenge = error.meta?.['challenge'];
  return typeof challenge === 'string' && challenge !== '' ? challenge : null;
}

/**
 * What the callback is refused with when no `mfaPath` was given: the same code, with the cause and
 * fix that are true for a built-in route — there is no "your sign-in handler" to catch it in — and
 * WITHOUT the challenge, which has nowhere to travel and so is not kept.
 */
export const mfaHandoffMissing = (factory: SignInFactory): AuthError =>
  new AuthError({
    code: 'X_MFA_REQUIRED',
    cause: `this account has TOTP enrolled, and ${factory}() was given no mfaPath to hand the second-factor challenge to, so the sign-in cannot finish`,
    fix: `${CALL[factory]}  // ${PAGE}`,
  });

/** The challenge as a `Set-Cookie`, living exactly as long as the challenge itself. */
export const mfaChallengeCookie = (challenge: string): string =>
  serializeSetCookie(MFA_CHALLENGE_COOKIE, challenge, {
    maxAge: Math.floor(MFA_CHALLENGE_TTL_MS / 1000),
  });

/** Sent with the response that finishes (or abandons) the second leg. */
export const clearMfaChallengeCookie = (): string =>
  serializeSetCookie(MFA_CHALLENGE_COOKIE, '', { maxAge: 0 });

/**
 * The challenge a built-in callback handed to `mfaPath`, or `null`: what `completeMfa` takes as its
 * second argument. Unverified here on purpose — `completeMfa` opens the seal and checks the expiry.
 */
export function readMfaChallenge(request: RequestLike): string | null {
  return readCookie(request.headers.get('cookie'), MFA_CHALLENGE_COOKIE);
}
