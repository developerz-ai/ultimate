// Single responsibility: `Result<T, E>` for boundaries where throwing is wrong —
// validation seams, driver probes, CLI commands that must render `--json` either way.

import { toUltimateError, type UltimateError } from './errors';

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export type Result<T, E = UltimateError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function map<T, E, U>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Throws the contained error — use only where a throw is genuinely correct. */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;
  throw toUltimateError(result.error);
}

export function tryCatch<T>(fn: () => Promise<T>): Promise<Result<T, UltimateError>>;
export function tryCatch<T>(fn: () => T): Result<T, UltimateError>;
export function tryCatch<T>(
  fn: () => T | Promise<T>,
): Result<T, UltimateError> | Promise<Result<T, UltimateError>> {
  try {
    const value = fn();
    if (isPromiseLike(value)) {
      return value.then(
        (resolved) => ok(resolved),
        (reason: unknown) => err(toUltimateError(reason)),
      );
    }
    return ok(value);
  } catch (thrown) {
    return err(toUltimateError(thrown));
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  );
}
