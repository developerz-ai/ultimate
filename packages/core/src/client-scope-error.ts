/**
 * The refusal a read in flight across `rescope()` rejects with — `X_CLIENT_SCOPE_CHANGED`. Its own
 * module, imported only by the transport: `client-scope.ts` is what `pageClient()` and every
 * `onRescope` subscriber reach, and constructing an `UltimateError` there put core's error registry
 * into a store-only island that never makes a request.
 */

import { UltimateError } from './errors';

/** Never a UI error: `isSuperseded(error)` answers true for it, and a caller renders nothing. */
export function scopeChanged(subject: string, issued: number, current: number): UltimateError {
  return new UltimateError({
    code: 'X_CLIENT_SCOPE_CHANGED',
    cause: `${subject} was issued for client scope epoch ${issued} and the page is now at ${current}, so its answer belongs to the previous principal`,
    fix: 'discard this answer and read again — test it with isSuperseded(error) from @ultimat3/core and render nothing for it',
    meta: { subject, issued, current },
  });
}
