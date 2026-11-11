// Single responsibility: a concurrent map with a stated width — results in input order, the first
// rejection (or the caller's abort) stops every item not yet started and tells the in-flight ones.

import { renderThrowable } from './error-render';
import { UltimateError } from './errors';
import { finiteCount } from './finite-option';

export interface MapBoundedOptions {
  /**
   * How many items run at once. REQUIRED, with no default: the right width is a fact about the
   * thing being called — a vendor's rate limit, a pool's size — and only the caller knows it.
   */
  readonly width: number;
  /** The deadline or the caller going away. Aborting stops every item not yet started. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * `Promise.all(items.map(fn))` with at most `width` in flight. `fn` receives a signal that aborts
 * on the first rejection — its reason IS that rejection — or when `options.signal` aborts, so a
 * well-behaved `fn` stops its own work too; nothing new starts after either.
 *
 * Rejects AT ONCE with the first failure, as `Promise.all` does: a sibling that ignores its signal
 * cannot hold the answer hostage. A later sibling's rejection is swallowed, never unhandled.
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  fn: (item: T, index: number, signal: AbortSignal) => R | Promise<R>,
  options: MapBoundedOptions,
): Promise<R[]> {
  const width = finiteCount('mapBounded', 'width', options.width, 1);
  const outer = options.signal;
  if (outer?.aborted) throw aborted(outer.reason, 0, items.length);
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const controller = new AbortController();
  let next = 0;
  let completed = 0;
  return new Promise<R[]>((resolve, reject) => {
    const fail = (error: unknown): void => {
      if (controller.signal.aborted) return;
      outer?.removeEventListener('abort', onAbort);
      controller.abort(error);
      reject(error);
    };
    const onAbort = (): void => fail(aborted(outer?.reason, completed, items.length));
    outer?.addEventListener('abort', onAbort, { once: true });

    // No abort check here: `pull` runs only in the synchronous first loop or past the success
    // branch's own check, so an aborted map never reaches it.
    const pull = (): void => {
      if (next >= items.length) return;
      const index = next++;
      // `.then` rather than a direct call: a SYNCHRONOUS throw in `fn` becomes this item's
      // rejection instead of escaping the runner that pulled it.
      Promise.resolve()
        .then(() => fn(items[index] as T, index, controller.signal))
        .then((value) => {
          if (controller.signal.aborted) return;
          results[index] = value;
          completed += 1;
          if (completed === items.length) {
            outer?.removeEventListener('abort', onAbort);
            resolve(results);
            return;
          }
          pull();
        }, fail);
    };
    for (let slot = 0; slot < Math.min(width, items.length); slot += 1) pull();
  });
}

function aborted(reason: unknown, completed: number, total: number): UltimateError {
  return new UltimateError({
    code: 'X_ABORTED',
    cause: `mapBounded stopped with ${completed} of ${total} items done: its signal aborted (${renderThrowable(reason)})`,
    fix: 'mapBounded(items, fn, { width, signal: AbortSignal.timeout(<ms>) })   # a larger <ms> or width when the signal is a deadline; a caller that went away left nothing to finish',
    meta: { completed, total },
  });
}
