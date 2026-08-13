// Compile-time pins for this package's disposable resources. Source, not a `.test.ts`, on
// purpose: `tsconfig.json` excludes `src/**/*.test.ts`, so `tsc -b` never reads a test file and a
// type-level assertion written there can never fail. This module emits nothing and exports
// nothing anybody imports — a regression is a build error, the only enforcement that counts
// (axiom 3). `DbConnection` and `Turn` both went through a session where `release()`/`close()`
// left a resource cached or unreturned; the fix each time was RAII (`Disposable` + `using`), and
// this pin is what stops a future edit from quietly dropping `Disposable` off either interface —
// the one place a regression here would otherwise surface is a leaked connection under load, not
// a red test.

import type { DbConnection } from './client';
import type { Turn } from './pglite-turns';

/** Fails to compile when `T` is anything but `true`. The whole mechanism. */
type Assert<T extends true> = T;

/**
 * The pinned handle `client.reserve()` returns must stay `Disposable`, or `using connection =
 * await client.reserve()` in `transaction.ts` / `readonly-query.ts` stops compiling as a
 * scope-bound resource and degrades silently back into a hand-rolled `try`/`finally`.
 */
export type _DbConnectionIsDisposable = Assert<[DbConnection] extends [Disposable] ? true : false>;

/**
 * PGlite's single-session turn must stay `Disposable` too, or `TurnQueue.run()`'s `using turn =
 * await this.take()` in `pglite-turns.ts` loses the same guarantee — the connection never gets
 * queued back to the next waiter on a throw.
 */
export type _TurnIsDisposable = Assert<[Turn] extends [Disposable] ? true : false>;
