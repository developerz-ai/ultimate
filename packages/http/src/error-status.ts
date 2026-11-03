// Reading the status table: the framework's row for a code through `Object.hasOwn`, the app's
// own codes beside it (`registerErrorStatus`), and the answer a response gets. The table itself is
// `error-map.ts`; the app's half lives in core (`error-status-declared.ts`), where `defineError`
// writes it too.
//
// The table's internal seam, never the barrel: an app's writers are `defineError` and this module's
// `registerErrorStatus`, and nothing else may write or read the app's half directly.
import {
  appErrorStatus,
  declareAppErrorStatus,
  resetAppErrorStatus,
} from '@ultimat3/core/internal/error-status';
import { ERROR_STATUS } from './error-map';
import { errorStatusInvalid } from './errors';

export const DEFAULT_STATUS = 500;

/**
 * The framework's row for a code, or `undefined` — through `Object.hasOwn`, never `[code]`.
 *
 * `code` is a STRING read off a throwable this package did not build, and `ERROR_STATUS` is an
 * object literal, so it holds every name on `Object.prototype`: an app throwing
 * `{ code: 'toString' }` read a FUNCTION out of this table. `statusFor` handed it to
 * `new Response(body, { status })` — a `RangeError` raised inside `recoverWith`'s fallback, the
 * one frame with nothing above it, so `Pipeline.handle` REJECTED against its own contract.
 * `scripts/error-map.ts` reads the same table this way already.
 */
const BY_CODE: Readonly<Record<string, number>> = ERROR_STATUS;

const frameworkStatus = (code: string): number | undefined =>
  Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : undefined;

/*
 * Statuses for codes the APP owns live in `@ultimat3/core`'s `error-status-declared.ts`. The table
 * above is closed — it has to be, it is the framework's own contract — and every code outside it
 * fell to 500, so a wrong password was an incident: `pipeline.ts` reports `status >= 500` to the
 * error monitor, and a user's typo paged whoever was on call. The app's half is kept separate so a
 * registration can never move `X_FORBIDDEN` off 403, and it sits in core because `defineError`,
 * the one declaration of an app code, writes it from there.
 */

/**
 * Declare the status for codes this app throws but does not DECLARE — a code it re-raises from a
 * library, say. A code the app owns is declared with core's `defineError`, which takes its status
 * in the same call. Call this once at boot; importing the module that calls it IS the registration.
 *
 * ```ts
 * registerErrorStatus({ X_CREDENTIALS_INVALID: 401, X_SIGNUP_CLOSED: 403 });
 * ```
 */
export const registerErrorStatus = (statuses: Readonly<Record<string, number>>): void => {
  for (const [code, status] of Object.entries(statuses)) {
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw errorStatusInvalid(code, `${String(status)} is not an HTTP status (100-599)`);
    }
    // The framework's own codes are not negotiable: an app that could map `X_UNAUTHENTICATED`
    // to 200 would be an app whose 401 contract every client already depends on, changed.
    // Through `frameworkStatus`, so this refusal cannot answer for a code the framework does not
    // own: `registerErrorStatus({ toString: 401 })` was rejected with a cause reading `the
    // framework already maps it to function toString() { [native code] }`.
    const framework = frameworkStatus(code);
    if (framework !== undefined) {
      throw errorStatusInvalid(code, `the framework already maps it to ${framework}`);
    }
    const existing = appErrorStatus(code);
    if (existing !== undefined && existing !== status) {
      throw errorStatusInvalid(code, `already registered as ${existing} by this app`);
    }
    declareAppErrorStatus(code, status);
  }
};

/** Test seam. Production registers once at boot and never unregisters. */
export const resetErrorStatus = (): void => resetAppErrorStatus();

/**
 * The status SOMEBODY declared for a code — the framework or the app — or `undefined` when
 * nobody did. The two questions `statusFor` used to answer at once are separate on purpose:
 * "what do we answer" is always a number, and "did anyone classify this" is what `error-facts.ts`
 * reads to decide whether a 5xx may carry the throwable's own words back to the caller.
 *
 * Framework table first: `registerErrorStatus` already refuses those codes, so the order is
 * belt-and-braces — but it is the belt that makes "the framework's statuses are fixed" true
 * even if a future caller reaches the map some other way.
 * The app's half is a `Map`, which is why it never had `frameworkStatus`'s defect — prefer one for
 * anything keyed by a value a caller chose.
 */
export const declaredStatusFor = (code: string): number | undefined =>
  frameworkStatus(code) ?? appErrorStatus(code);

export const statusFor = (code: string): number => declaredStatusFor(code) ?? DEFAULT_STATUS;
