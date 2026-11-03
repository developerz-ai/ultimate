// Single responsibility: the APP's half of the HTTP status table — codes an app owns, mapped to the
// status a response answers. Here rather than in `@ultimat3/http` because `defineError` (core)
// writes it and core may not import upward; `@ultimat3/http`'s `registerErrorStatus` writes the same
// table, and its `declaredStatusFor` reads the framework's closed table FIRST, so no row here moves one.
//
// INTERNAL: reached through `@ultimat3/core/internal/error-status`, never the barrel — an app has one
// writer of its own (`defineError`) and one for a re-raised library code (`registerErrorStatus`).

import { renderCauseValue, renderFixShellArg } from './error-render';
import { UltimateError } from './errors';

/** A `Map`, never an object literal: the key is a caller's string, and `'toString'` is one. */
const APP_ERROR_STATUS = new Map<string, number>();

/**
 * Every code `defineError` declared, with its status — `undefined` for an off-socket one. Beside the
 * table, not in `define-error.ts`, so a reset and a snapshot cover both: a record that outlived its
 * table refused a test's fresh declaration of the same code.
 */
const DEFINED = new Map<string, number | undefined>();

/** Is `status` a value a `Response` can carry? */
export const isHttpStatus = (status: unknown): status is number =>
  typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;

/** The status this app declared for `code`, `undefined` when it declared none. */
export const appErrorStatus = (code: string): number | undefined => APP_ERROR_STATUS.get(code);

/**
 * Write one row. The two writers — `defineError` and `registerErrorStatus` — each refuse first with
 * their own code, so this is the last line, not the first: a status outside 100-599 or a second,
 * different status for one code can never reach the table whoever forgot to check.
 */
export function declareAppErrorStatus(code: string, status: number): void {
  const existing = APP_ERROR_STATUS.get(code);
  if (!isHttpStatus(status) || (existing !== undefined && existing !== status)) {
    throw new UltimateError({
      code: 'X_ERROR_DECLARATION_INVALID',
      cause: `${code} cannot answer ${renderCauseValue(status)}: ${
        existing === undefined
          ? 'that is not an HTTP status (100-599)'
          : `this app already declared it as ${existing}`
      }`,
      fix: `grep -rn ${renderFixShellArg(code, '<CODE>')} apps packages   # keep one declaration, one status, then x verify --only errors`,
      meta: { code },
    });
  }
  APP_ERROR_STATUS.set(code, status);
}

/** Whether `defineError` declared `code`, and with which status (`undefined` = off-socket). */
export const definedErrorStatus = (
  code: string,
): { readonly status: number | undefined } | undefined =>
  DEFINED.has(code) ? { status: DEFINED.get(code) } : undefined;

/** `defineError`'s record of a declaration it accepted. */
export const recordDefinedError = (code: string, status: number | undefined): void => {
  DEFINED.set(code, status);
};

/** Test seam. Production declares once at boot and never undeclares. */
export const resetAppErrorStatus = (): void => {
  APP_ERROR_STATUS.clear();
  DEFINED.clear();
};

/**
 * Test-only: capture the table and get the undo back — `errorCodeSnapshot`'s shape, for the same
 * reason. Bun runs one process per suite, every app module declares at import, and a bare
 * `resetAppErrorStatus()` strips rows the file never wrote.
 */
export function appErrorStatusSnapshot(): () => void {
  const saved = new Map(APP_ERROR_STATUS);
  const defined = new Map(DEFINED);
  return () => {
    APP_ERROR_STATUS.clear();
    for (const [code, status] of saved) APP_ERROR_STATUS.set(code, status);
    DEFINED.clear();
    for (const [code, status] of defined) DEFINED.set(code, status);
  };
}
