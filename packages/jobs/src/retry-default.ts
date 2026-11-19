// The retry a job that declares none runs under: `DEFAULT_RETRY`, or what the app's boot installed
// over it from `jobs.maxAttempts` / `jobs.backoff`. Resolved on READ, never at declaration: a handle
// is built when its module is imported, which is before the boot has read the config.

import { finiteCount } from '@ultimat3/core';
import type { BackoffStrategy, RetryPolicy } from './retry';
import { DEFAULT_RETRY } from './retry';

/** The two retry facts an app sets for every job at once. */
export interface DefaultRetry {
  /** Total attempts including the first, for a job that declares no `retry`. */
  readonly attempts: number;
  /** The curve of a `retry` that names no `backoff`. */
  readonly backoff: BackoffStrategy;
}

let installed: DefaultRetry | undefined;

/**
 * Install the app's default, process-wide. EVERY role installs it, not the worker alone: the
 * process that enqueues stamps the row's `max_attempts` from the same policy the worker retries
 * by, and two answers bury a lapsed lease on an attempt the worker would have retried.
 */
export function installDefaultRetry(policy: DefaultRetry): void {
  installed = {
    attempts: finiteCount('installDefaultRetry', 'attempts', policy.attempts, 1),
    backoff: policy.backoff,
  };
}

export function resetDefaultRetry(): void {
  installed = undefined;
}

/**
 * The policy a handle runs under, given what its definition was handed. `DEFAULT_RETRY` ITSELF is
 * "declares none" — what every factory passes for an omitted `retry` — and takes the installed
 * attempts and curve. A declared policy keeps its own attempts, and the installed curve only when
 * it names none.
 */
export function resolvedRetry(declared: RetryPolicy): RetryPolicy {
  if (installed === undefined) return { ...DEFAULT_RETRY, ...declared };
  if (declared === DEFAULT_RETRY) return { ...DEFAULT_RETRY, ...installed };
  return { ...DEFAULT_RETRY, backoff: installed.backoff, ...declared };
}
