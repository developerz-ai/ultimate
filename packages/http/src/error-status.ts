// Reading the status table: the framework's row for a code through `Object.hasOwn`, the app's
// own codes beside it (`registerErrorStatus`), and the answer a response gets. The table itself is
// `error-map.ts`; split out when the table outgrew the file that also read it.
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

/**
 * Statuses for codes the APP owns. The table above is closed — it has to be, it is the
 * framework's own contract — and every code outside it fell to 500, so a wrong password was an
 * incident: `pipeline.ts` reports `status >= 500` to the error monitor, and a user's typo paged
 * whoever was on call. This is the app's half of the same table, kept separate so a registration
 * can never move `X_FORBIDDEN` off 403.
 */
const APP_ERROR_STATUS = new Map<string, number>();

/**
 * Declare the status for the codes this app throws. Call it once at boot, beside the module
 * that declares the codes — importing that module IS the registration, the convention
 * `registerActions` and `registerErrorCodes` already use.
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
    const existing = APP_ERROR_STATUS.get(code);
    if (existing !== undefined && existing !== status) {
      throw errorStatusInvalid(code, `already registered as ${existing} by this app`);
    }
    APP_ERROR_STATUS.set(code, status);
  }
};

/** Test seam. Production registers once at boot and never unregisters. */
export const resetErrorStatus = (): void => APP_ERROR_STATUS.clear();

/**
 * The status SOMEBODY declared for a code — the framework or the app — or `undefined` when
 * nobody did. The two questions `statusFor` used to answer at once are separate on purpose:
 * "what do we answer" is always a number, and "did anyone classify this" is what `error-facts.ts`
 * reads to decide whether a 5xx may carry the throwable's own words back to the caller.
 *
 * Framework table first: `registerErrorStatus` already refuses those codes, so the order is
 * belt-and-braces — but it is the belt that makes "the framework's statuses are fixed" true
 * even if a future caller reaches the map some other way.
 * `APP_ERROR_STATUS` is a `Map`, which is why its half never had `frameworkStatus`'s defect —
 * prefer one for anything keyed by a value a caller chose.
 */
export const declaredStatusFor = (code: string): number | undefined =>
  frameworkStatus(code) ?? APP_ERROR_STATUS.get(code);

export const statusFor = (code: string): number => declaredStatusFor(code) ?? DEFAULT_STATUS;
