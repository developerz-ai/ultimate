// Single responsibility: refusing a late answer whose world has moved on. A monotonic counter, the
// generation a caller was issued when it started, and one guard between the two — the piece no
// package in the framework had, and the reason a cancelled reload's response could still land on
// top of the one that replaced it.

import { isUltimateError, UltimateError } from './errors';

export interface GenerationFence {
  /** The generation to carry alongside work started NOW. */
  generation(): number;
  /** Everything issued before this call is superseded. Returns the new generation. */
  bump(): number;
  /** Throws `X_SUPERSEDED` unless `issued` is still the current generation. */
  guard(issued: number): void;
}

/**
 * `subject` names what the generation counts, and it reaches the `cause:` — "the live window was
 * superseded" is actionable where "generation 3 != 4" is a puzzle.
 */
export function createFence(subject: string): GenerationFence {
  let current = 0;
  return {
    generation: (): number => current,
    bump: (): number => {
      current += 1;
      return current;
    },
    guard: (issued: number): void => {
      // `!==`, never `<`. A generation from the future cannot happen and therefore means the
      // caller carried a token from ANOTHER fence — the one case where letting the work land is
      // strictly worse than refusing it, because nothing about it was ever fenced.
      if (issued === current) return;
      throw superseded(subject, issued, current);
    },
  };
}

/**
 * `X_SUPERSEDED` is classified `terminal` in `error-retry.ts`'s core table rather than through a
 * `registerErrorRetry()` call here: a module-scope registration is an import-time side effect this
 * package would have to declare in `sideEffects`, and `resetErrorRetry()` in any test would drop
 * it. The classification is load-bearing — see that table for why an undeclared one is not enough.
 */
function superseded(subject: string, issued: number, current: number): UltimateError {
  return new UltimateError({
    code: 'X_SUPERSEDED',
    cause: `${subject} was issued at generation ${issued} and the fence is now at ${current}, so this answer describes a world that no longer exists`,
    fix: 'discard this answer and re-issue the work against fence.generation() — whoever called bump() has already started the replacement',
    meta: { subject, issued, current },
  });
}

/** Whether a caught value is this refusal. The one reader a caller needs; never `error.code`. */
export function isSuperseded(error: unknown): boolean {
  return isUltimateError(error) && error.code === 'X_SUPERSEDED';
}
