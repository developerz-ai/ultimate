// Single responsibility: compile-time-backed runtime assertions. Exhaustive switches and
// invariants both fail with a real error code, never a bare Error.

import { renderCauseValue } from './error-render';
import { UltimateError } from './errors';

export interface InvariantOptions {
  readonly docs?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Put in the `default` branch of a switch over a union. Adding a union member becomes a
 * type error at the call site instead of a silent fallthrough at runtime.
 */
export function assertNever(value: never, fix?: string): never {
  throw new UltimateError({
    code: 'X_UNREACHABLE',
    // `JSON.stringify` raises on a bigint and on a cycle, and `String()` raises on a symbol, so
    // the cause threw BEFORE `X_UNREACHABLE` existed: the caller caught a TypeError where a coded
    // refusal belongs, and catching by code found nothing.
    cause: `unhandled variant: ${renderCauseValue(value)}`,
    fix: fix ?? 'add a case for the variant named in cause',
    meta: { value },
  });
}

export function invariant(
  condition: unknown,
  code: string,
  cause: string,
  fix: string,
  options?: InvariantOptions,
): asserts condition {
  if (condition) return;
  throw new UltimateError({
    code,
    cause,
    fix,
    docs: options?.docs,
    meta: options?.meta,
  });
}

/** `invariant` with the generic code, for checks that have no dedicated code yet. */
export function assert(condition: unknown, cause: string, fix: string): asserts condition {
  invariant(condition, 'X_INVARIANT', cause, fix);
}
