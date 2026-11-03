// Single responsibility: `defineError` — an APP code's one declaration: its title, its HTTP status
// (or `offSocket`), its retry, and the `UltimateError` subclass that throws it. Its own module so a
// chunk importing only `UltimateError` never retains it (`define-error-bytes.test.ts`). A framework
// code goes through `bun run new-error-code` instead; the split is in this package's CLAUDE.md.

import { describeErrorCode, hasErrorCode, registerErrorCodes } from './error-codes';
import { renderCauseValue } from './error-render';
import { type ErrorRetry, registerErrorRetry } from './error-retry';
import {
  appErrorStatus,
  declareAppErrorStatus,
  definedErrorStatus,
  isHttpStatus,
  recordDefinedError,
} from './error-status-declared';
import { isUltimateError, UltimateError } from './errors';

/** A line written once, or computed from the throw's params. */
export type ErrorText<P> = string | ((params: P) => string);

interface ErrorSpecFields<P> {
  /** `X_SCREAMING_SNAKE`, written as a literal here: the `errors` step and the manifest read it. */
  readonly code: string;
  readonly title: string;
  readonly cause: ErrorText<P>;
  /** A command to run, a call to paste, or an edit naming a file — `x verify --only errors` checks. */
  readonly fix: ErrorText<P>;
  readonly callerFix?: ErrorText<P> | undefined;
  readonly docs?: string | undefined;
  readonly retry?: ErrorRetry | undefined;
  readonly meta?: ((params: P) => Readonly<Record<string, unknown>>) | undefined;
}

/**
 * Exactly one of `status` (what a response answers) or `offSocket: true` (a boot, CLI or job fault
 * no response ever carries). Neither was the 500-by-omission a reference app shipped for "post not
 * found"; the type makes the choice, and `X_ERROR_DECLARATION_INVALID` holds it at runtime.
 */
export type DefineErrorSpec<P = undefined> = ErrorSpecFields<P> &
  (
    | { readonly status: number; readonly offSocket?: undefined }
    | { readonly offSocket: true; readonly status?: undefined }
  );

/** What a throw site may add beyond the params: the value it wraps, and a one-site retry. */
export interface DefinedErrorExtra {
  readonly sourceError?: unknown;
  readonly retry?: ErrorRetry | undefined;
}

type DefinedErrorArgs<P> = [P] extends [undefined]
  ? [params?: undefined, extra?: DefinedErrorExtra]
  : [params: P, extra?: DefinedErrorExtra];

export interface DefinedError<P = undefined> {
  new (...args: DefinedErrorArgs<P>): UltimateError;
  readonly prototype: UltimateError;
  readonly code: string;
  /** `undefined` when declared `offSocket`. */
  readonly status: number | undefined;
  /**
   * The brand plus the code — never `instanceof`, which a browser's `RemoteActionError` and a
   * duplicated module instance both fail.
   */
  is(value: unknown): value is UltimateError;
}

const SCREAMING_SNAKE = /^X(?:_[A-Z0-9]+)+$/;

const invalid = (code: unknown, cause: string): UltimateError =>
  new UltimateError({
    code: 'X_ERROR_DECLARATION_INVALID',
    cause: `defineError({ code: ${renderCauseValue(code)} }) ${cause}`,
    fix: 'x verify --only errors   # after editing the defineError call the cause names',
    meta: { code: renderCauseValue(code) },
  });

const duplicate = (code: string, cause: string): UltimateError =>
  new UltimateError({
    code: 'X_ERROR_CODE_DUPLICATE',
    cause: `${code} is already declared ${cause}`,
    fix: `grep -rn "${code}" apps packages   # keep one declaration of the code, then x verify --only errors`,
    meta: { code },
  });

const text = <P>(value: ErrorText<P>, params: P): string =>
  typeof value === 'function' ? value(params) : value;

/** Every refusal, before any table is written: a refused declaration leaves no half behind. */
function refusalOf<P>(spec: DefineErrorSpec<P>): UltimateError | undefined {
  const { code } = spec;
  if (typeof code !== 'string' || !SCREAMING_SNAKE.test(code)) {
    return invalid(code, 'is not X_SCREAMING_SNAKE (X_ then upper-case words and digits)');
  }
  const hasStatus = spec.status !== undefined;
  const offSocket = spec.offSocket === true;
  if (hasStatus === offSocket) {
    return invalid(
      code,
      hasStatus ? 'gives both status and offSocket' : 'gives neither status nor offSocket',
    );
  }
  if (hasStatus && !isHttpStatus(spec.status)) {
    return invalid(
      code,
      `gives status ${renderCauseValue(spec.status)}, which is not an HTTP status (100-599)`,
    );
  }
  const defined = definedErrorStatus(code);
  if (hasErrorCode(code)) {
    // Registered and not by this function: a framework package's code (or an app table's). Its
    // status is not this declaration's to give — X_FORBIDDEN's class would claim 200 while http
    // answers 403 — so a matching title is no licence.
    if (defined === undefined) return duplicate(code, 'by the framework');
    const title = describeErrorCode(code).title;
    if (title !== spec.title) {
      return duplicate(code, `with the title ${renderCauseValue(title)}`);
    }
  }
  // Off-socket is a declaration too, so a later `status: 404` for it is a disagreement — which only
  // the record can see: the status table holds no row for an off-socket code.
  const status = defined === undefined ? appErrorStatus(code) : defined.status;
  if ((defined !== undefined || status !== undefined) && status !== spec.status) {
    return duplicate(code, status === undefined ? 'off-socket' : `with the status ${status}`);
  }
  return undefined;
}

/**
 * Declare an app error code and get its class back. Importing the module that calls it IS the
 * registration — `registerErrorCodes`' convention. The same declaration twice is a no-op (a module
 * re-evaluated under `x dev`); a different title or status is `X_ERROR_CODE_DUPLICATE`.
 *
 * ```ts
 * export const PostNotFound = defineError<{ readonly ref: string }>({
 *   code: 'X_POST_NOT_FOUND',
 *   title: 'no such post in this organisation',
 *   status: 404,
 *   cause: (p) => `no post ${p.ref} in the actor's organisation`,
 *   fix: 'x queries show postById --json, then pass an id it returns',
 * });
 * throw new PostNotFound({ ref });
 * ```
 */
export function defineError<P = undefined>(spec: DefineErrorSpec<P>): DefinedError<P> {
  const refused = refusalOf(spec);
  if (refused !== undefined) throw refused;
  const { code } = spec;
  // `registerErrorRetry` refuses an unknown kind or a conflicting one BEFORE it writes, and the
  // two writes after it cannot fail: `refusalOf` already answered for both.
  if (spec.retry !== undefined) registerErrorRetry({ [code]: spec.retry });
  if (!hasErrorCode(code)) {
    registerErrorCodes({ [code]: { title: spec.title, docs: spec.docs } });
  }
  if (spec.status !== undefined) declareAppErrorStatus(code, spec.status);
  recordDefinedError(code, spec.status);

  class Defined extends UltimateError {
    static readonly code = code;
    static readonly status = spec.status;

    static is(value: unknown): value is UltimateError {
      return isUltimateError(value) && value.code === code;
    }

    constructor(...[params, extra]: DefinedErrorArgs<P>) {
      const input = params as P;
      super({
        code,
        cause: text(spec.cause, input),
        fix: text(spec.fix, input),
        callerFix: spec.callerFix === undefined ? undefined : text(spec.callerFix, input),
        docs: spec.docs,
        meta: spec.meta?.(input),
        retry: extra?.retry,
        sourceError: extra?.sourceError,
      });
    }
  }
  return Defined;
}
