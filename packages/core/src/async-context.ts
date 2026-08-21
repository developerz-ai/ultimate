// Single responsibility: the one lazily-constructed `AsyncLocalStorage` in the framework. Every
// ambient value core carries — the request context, the active span, the impersonation reason —
// opens its scope through this seam, so "what happens where there is no async context" has one
// answer instead of one per module.

// `node:async_hooks` is unavoidable and deliberate: nothing else in Bun makes a value ambient
// across an `await` without threading it through every signature in the framework.
import { AsyncLocalStorage } from 'node:async_hooks';
import { UltimateError } from './errors';

export interface AsyncContext<T> {
  /** The value in flight, or `undefined` — outside a scope, and in a runtime that has none. */
  get(): T | undefined;
  /** Run `fn` with `value` in flight. `X_ASYNC_CONTEXT_UNAVAILABLE` where that is impossible. */
  run<R>(value: T, fn: () => R): R;
}

/**
 * The storage is constructed on the first `get()` or `run()`, never at module scope. That is the
 * whole point of this file: a browser bundler stubs `node:async_hooks` to `{}` — Bun's
 * `target: 'browser'` emits `var { AsyncLocalStorage } = (() => ({}))` — so a module-scope `new` threw
 * `TypeError: undefined is not a constructor` at module EVALUATION, and every package that
 * transitively imports core was dead on arrival in a client bundle. `@ultimat3/ui` calls itself a
 * SolidJS design system and could not be put on a client by the only client bundler the framework
 * has, for this reason and no other.
 *
 * The laziness buys the browser bundle, not a server allocation. `open()` runs on a READ as well as
 * a write, so a server whose first call is `get()` constructs the storage there — it is deferred,
 * never skipped. What deferring changes is nothing observable: `getStore()` outside a scope answers
 * `undefined` whether the storage was ever constructed or not, which is what makes it safe.
 *
 * **Reads degrade, writes throw**, and that split is the doctrine rather than a convenience.
 * `get()` answers `undefined` in a browser because that is TRUE — nothing is in flight there, so
 * "am I inside a scope" has a definite no for an answer and does not deserve an exception. It is
 * the same call `@ultimat3/ui`'s `solid()` makes: inert where the capability is genuinely absent,
 * throwing only where a caller asked for something the runtime cannot deliver. `run()` is that
 * second case, so it names itself with a code and a fix rather than leaving a bare `TypeError`
 * from a stack that mentions no file the caller wrote.
 *
 * **A synchronous save/restore fallback is not the answer here**, and this note exists so that it
 * is not re-proposed: a module-level `current` swapped in a `try`/`finally` serves sync code and
 * is silently WRONG across an `await` — two overlapping scopes interleave and the second one's
 * `finally` restores a value the first is still inside. That is the `jobs: { driver: 'redis' }`
 * failure mode this repo already paid for once: accepted, unwarned, and wrong in the dangerous
 * direction. An error a caller can read beats an ambient value that is occasionally somebody
 * else's.
 *
 * `subject` names what could not be opened, and is a `string` by construction — never an
 * `unknown` reaching a `cause:`, which `bun run error-render` refuses.
 */
export function asyncContext<T>(subject: string): AsyncContext<T> {
  let storage: AsyncLocalStorage<T> | undefined;

  function open(): AsyncLocalStorage<T> | undefined {
    if (storage !== undefined) return storage;
    // The stub is an object with no `AsyncLocalStorage` key, so the binding reads `undefined`.
    if (typeof AsyncLocalStorage !== 'function') return undefined;
    storage = new AsyncLocalStorage<T>();
    return storage;
  }

  return {
    get(): T | undefined {
      return open()?.getStore();
    },
    run<R>(value: T, fn: () => R): R {
      const store = open();
      if (store === undefined) {
        throw new UltimateError({
          code: 'X_ASYNC_CONTEXT_UNAVAILABLE',
          cause: `${subject} needs AsyncLocalStorage, and node:async_hooks is stubbed to {} in this runtime`,
          fix: `${subject} is server-only — open it in apps/web/server.ts or a route handler, and keep every module that opens one out of the import graph of a client island entry`,
          meta: { subject },
        });
      }
      return store.run(value, fn);
    },
  };
}
