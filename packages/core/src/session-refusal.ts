/**
 * "This credential names no session", decided once. An authenticator answers it with `null` or by
 * throwing one of these codes; every host — the http `auth` stage, the realtime re-auth sweep, the
 * page's session-lost flag — reads both as the same answer, never as a backend failure.
 */

import { isUltimateError } from './errors';

/**
 * `@ultimat3/auth`'s two session refusals: `X_SESSION_EXPIRED` past either clock,
 * `X_UNAUTHENTICATED` for a session unknown, revoked, forged or whose user is disabled. Exported
 * inside core only, never from `index.ts`: `session-lost.ts` reads the set directly, because a
 * function wrapper around it cost every page bundle 28 B and bought no behaviour.
 */
export const SESSION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  'X_UNAUTHENTICATED',
  'X_SESSION_EXPIRED',
]);

/** Whether a wire code — a 401's `code` — says the credential names no session. */
export function isSessionRefusalCode(code: string): boolean {
  return SESSION_REFUSAL_CODES.has(code);
}

/**
 * Whether a thrown value is an authenticator's "no session" rather than a failure. Only a coded
 * `UltimateError` counts: a plain object with a `code` field is not one this framework raised.
 */
export function isSessionRefusal(thrown: unknown): boolean {
  return isUltimateError(thrown) && SESSION_REFUSAL_CODES.has(thrown.code);
}
