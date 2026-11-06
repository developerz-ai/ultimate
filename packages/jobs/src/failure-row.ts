// A job row's `last_error` read for a CALLER: the code it was thrown with and the `callerFix` it
// declared. One text column holds two audiences, split by the one tab no rendered field contains.

import { hasErrorCode } from '@ultimat3/core';

/**
 * Between the operator's line and the caller's fix. `failureForRow` runs the operator's line
 * through core's `singleLine`, which escapes every control character, so the first raw tab in a
 * row is this one — a thrown message cannot write it, and so cannot forge a caller's fix.
 */
export const CALLER_FIX_SEPARATOR = '\tcaller fix: ';

/** What a remote caller may be told about a failed job. Never the worker's text. */
export interface CallerFailure {
  /** A registered code the row's failure was THROWN with, else `X_INTERNAL`. */
  readonly code: string;
  /** The thrown error's declared `callerFix`; absent when it declared none. */
  readonly callerFix?: string;
}

/** `<name>: <CODE>: …` — the leading position `renderThrowable` gives a coded error. */
const LEADING_CODE = /^[A-Za-z]*: (X(?:_[A-Z0-9]+)+): /;

/**
 * The failure as a caller reads it. Only a code in the leading position counts — a `TypeError`
 * whose message merely mentions one is not that code — and only a code this process registered;
 * anything else is `X_INTERNAL`, http's name for the same case, and carries no fix of its own.
 * The developer's `fix:` is on the operator's line and never crosses (core's `fixFor`).
 */
export function callerFailure(lastError: string | undefined): CallerFailure {
  const row = lastError ?? '';
  const code = LEADING_CODE.exec(row)?.[1];
  if (code === undefined || !hasErrorCode(code)) return { code: 'X_INTERNAL' };
  const at = row.indexOf(CALLER_FIX_SEPARATOR);
  if (at === -1) return { code };
  return { code, callerFix: row.slice(at + CALLER_FIX_SEPARATOR.length) };
}

/** `row` with `suffix` appended to the operator's half, the caller's fix (if any) kept last. */
export function appendToOperatorLine(row: string, suffix: string): string {
  const at = row.indexOf(CALLER_FIX_SEPARATOR);
  return at === -1 ? `${row}${suffix}` : `${row.slice(0, at)}${suffix}${row.slice(at)}`;
}
