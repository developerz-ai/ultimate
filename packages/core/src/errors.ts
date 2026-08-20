// Single responsibility: `UltimateError` — the one error type every Ultimate package throws.
// Stable code + cause + exact fix command, rendered identically in the terminal, the browser
// overlay and `--json`. Never throw a bare Error anywhere in the framework.

import { describeErrorCode } from './error-codes';
import {
  isThrownError,
  renderCauseValue,
  renderMetaRecord,
  renderThrowable,
  singleLine,
} from './error-render';
import { DEFAULT_ERROR_RETRY, type ErrorRetry, isErrorRetry, retryFor } from './error-retry';

/**
 * Structural brand. `instanceof` is unreliable across duplicated module instances and across
 * tier-0 packages that may not import each other (`@ultimat3/schema` cannot import
 * `@ultimat3/core`), so the guard is duck-typed on a well-known symbol instead.
 */
export const ULTIMATE_ERROR_BRAND: unique symbol = Symbol.for('ultimate.error');

export interface UltimateErrorInit {
  /** `SCREAMING_SNAKE`, prefixed `X_`. Must exist in the code registry to get a title. */
  readonly code: string;
  /** What actually happened, concrete and specific. Never a generic sentence. */
  readonly cause: string;
  /** The exact command or edit that fixes it. */
  readonly fix: string;
  readonly docs?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Overrides the code's registered classification for this one throw — the same code can be
   * transient at one call site and permanent at another. Defaults to `retryFor(code)`, which
   * defaults to `terminal`.
   */
  readonly retry?: ErrorRetry | undefined;
  /** The underlying thrown value, when this error wraps one. */
  readonly sourceError?: unknown;
}

export interface UltimateErrorJSON {
  readonly code: string;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  /** Whether a client may try again. Always present — a client never has to infer it. */
  readonly retry: ErrorRetry;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  readonly stack?: string | undefined;
}

export interface FormatErrorOptions {
  /** Append a 4th `docs:` line. Off by default — the contract's rendering is 3 lines. */
  readonly docs?: boolean | undefined;
}

export class UltimateError extends Error {
  readonly [ULTIMATE_ERROR_BRAND] = true;
  override readonly name: string = 'UltimateError';
  readonly code: string;
  readonly title: string;
  /** Set by `Error`'s `cause` option; always a human-readable string in Ultimate. */
  declare readonly cause: string;
  readonly fix: string;
  readonly docs: string;
  readonly retry: ErrorRetry;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  readonly sourceError: unknown;

  constructor(init: UltimateErrorInit) {
    const described = describeErrorCode(init.code);
    // `message` carries the cause because it is the ONLY field a runtime prints when an
    // error escapes uncaught — a worker log, a CI transcript, a stack trace. A message of
    // just `code: title` tells an operator which rule fired but not which row, column or
    // value, which is the opposite of "errors are instructions". `format()` still renders
    // the canonical 3 lines from the fields, so the two never disagree.
    super(`${init.code}: ${described.title} — ${init.cause}`, { cause: init.cause });
    this.code = init.code;
    this.title = described.title;
    this.fix = init.fix;
    this.docs = init.docs ?? described.docs;
    this.retry = init.retry ?? retryFor(init.code);
    this.meta = init.meta;
    this.sourceError = init.sourceError;
  }

  /**
   * The canonical 3-line terminal rendering:
   *
   * ```text
   * X_DB_DRIFT: schema differs from migrations
   *   cause: table "posts" has column "publish_at" not present in any migration
   *   fix:   x db gen "add publish_at"
   * ```
   */
  format(options?: FormatErrorOptions): string {
    // `singleLine`, because this format is line-oriented and `cause` may hold a caller's string:
    // one newline in it writes a second line an operator reads as a genuine framework message.
    const lines = [
      `${singleLine(this.code)}: ${singleLine(this.title)}`,
      `  cause: ${singleLine(this.cause)}`,
      `  fix:   ${singleLine(this.fix)}`,
    ];
    if (options?.docs === true) lines.push(`  docs:  ${singleLine(this.docs)}`);
    return lines.join('\n');
  }

  /**
   * `meta` is the only field here the framework does not build itself — `parseId` puts the value
   * it rejected straight in — so it goes through `renderMetaRecord`, which returns a record that
   * serialises unchanged and degrades only the keys that would have thrown. `--json` on every
   * error is a promise this method keeps; a `meta` that throws breaks it one layer past the
   * constructor.
   */
  toJSON(): UltimateErrorJSON {
    return {
      code: this.code,
      title: this.title,
      cause: this.cause,
      fix: this.fix,
      docs: this.docs,
      retry: this.retry,
      meta: renderMetaRecord(this.meta),
      stack: this.stack,
    };
  }
}

export function isUltimateError(value: unknown): value is UltimateError {
  // TOTAL, like `isThrownError`: `in` runs a `Proxy`'s `has` trap, and every caller asks this
  // question inside a `catch` block that has nothing left to answer with if the probe itself
  // throws. `false` is the honest answer for a value that refuses to be examined.
  try {
    return typeof value === 'object' && value !== null && ULTIMATE_ERROR_BRAND in value;
  } catch {
    return false;
  }
}

/** Init for a subclass that owns its code. */
export type CodedErrorInit = Omit<UltimateErrorInit, 'code'>;

export class ConfigInvalidError extends UltimateError {
  static readonly code = 'X_CONFIG_INVALID';
  override readonly name = 'ConfigInvalidError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: ConfigInvalidError.code });
  }
}

export class EnvMissingError extends UltimateError {
  static readonly code = 'X_ENV_MISSING';
  override readonly name = 'EnvMissingError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: EnvMissingError.code });
  }
}

export class NotImplementedError extends UltimateError {
  static readonly code = 'X_NOT_IMPLEMENTED';
  override readonly name = 'NotImplementedError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: NotImplementedError.code });
  }
}

export class InternalError extends UltimateError {
  static readonly code = 'X_INTERNAL';
  override readonly name = 'InternalError';
  constructor(init: CodedErrorInit) {
    super({ ...init, code: InternalError.code });
  }
}

/** The blessed shape for an unimplemented remote driver. Always carries a real fix line. */
export function notImplemented(feature: string, fix: string): never {
  throw new NotImplementedError({ cause: `${feature} is not implemented by this driver`, fix });
}

/**
 * Normalise anything caught into an `UltimateError` without losing the original.
 *
 * `renderCauseValue`, not `String(value)`: this is the framework's universal normaliser — the CLI's
 * every catch, `formatError`, the HTTP 500 path — and `String()` runs the value's own `toString`,
 * so a thrown object could make the wrapper throw and take both errors with it.
 */
export function toUltimateError(value: unknown, fix?: string): UltimateError {
  if (isUltimateError(value)) return value;
  // `isThrownError` / `renderThrowable`, not `instanceof` and `.message` directly: a `Proxy` traps
  // `getPrototypeOf` and a subclass can put a getter on `message`, so both reads throw where this
  // function is the last thing standing between a caught value and a surface that must answer.
  const cause = isThrownError(value)
    ? renderThrowable(value)
    : `non-error value thrown: ${renderCauseValue(value)}`;
  return new InternalError({
    cause,
    fix: fix ?? 'fix the underlying failure named in cause, then re-run',
    sourceError: value,
  });
}

/**
 * May a client try this again? The one question a retry loop asks, answered from the error rather
 * than from a status code — `X_DB_DRIFT` and `X_TENANCY_UNSCOPED` are both 500s and neither is
 * worth a second attempt. A value that is not an Ultimate error is `terminal`: fail closed.
 */
export function errorRetry(value: unknown): ErrorRetry {
  if (!isUltimateError(value)) return DEFAULT_ERROR_RETRY;
  // Read defensively: the brand is duck-typed across duplicated module instances, so a value from
  // an older copy of this package can satisfy the guard without carrying the field.
  const retry: unknown = value.retry;
  return isErrorRetry(retry) ? retry : DEFAULT_ERROR_RETRY;
}

/** Render any caught value with the 3-line contract, so CLI output never varies. */
export function formatError(value: unknown, options?: FormatErrorOptions): string {
  return toUltimateError(value).format(options);
}
