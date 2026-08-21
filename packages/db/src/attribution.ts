// Single responsibility: carry "which entity, which operation" from the layer that compiled a
// statement down to the funnel that sends it, so a diagnostic reads `50× findById on members`
// instead of fifty copies of one `select`. A scope, not a parameter: the statement leaves several
// frames and at least one microtask below the repository call that caused it.

// The pair has to survive every `await` between the repository call and the statement it causes,
// and a module-scope variable would be shared by two concurrent requests — so it needs an async
// context. It opens through core's seam for the same reason `expected-loop.ts` does: constructing
// an `AsyncLocalStorage` here threw at module EVALUATION in a browser bundle, where
// `node:async_hooks` is stubbed to `{}`, taking every importer of `@ultimat3/db` down with it.
import { asyncContext } from '@ultimat3/core';
import { type StatementAttribution, statementObserver } from './observe';

const storage = asyncContext<StatementAttribution>('the statement attribution');

/**
 * Run `fn` with every statement it issues — at any depth, across every `await` — attributed to
 * `entity` and `op`. `@ultimat3/entity`'s `postgresRepo` is the one producer: it is the last caller
 * that still knows both once the SQL exists, and it wraps each repository method rather than each
 * `client()` call because the statement is sent below it — inside the coalescer's microtask flush,
 * inside a chunked write loop, inside `readByIds` for a preload.
 *
 * Nesting keeps the innermost pair, exactly as `expectedQueryLoop` keeps the innermost reason: a
 * relation preloaded during `findMany` reads through the *related* repository, and that read is
 * what its own statement is.
 *
 * **With no observer installed this enters no scope at all** — one property read, one branch, no
 * object allocated (axiom 6). Which is also why the pair arrives as two strings rather than as a
 * `StatementAttribution`: a literal at the call site would be allocated before the branch could
 * decline it, on the path every statement in the process takes. An observer installed *during*
 * `fn` therefore sees the statements that follow unattributed; installation happens once, at boot,
 * and paying for the scope on every production statement to close that window is the wrong trade.
 */
export function withStatementAttribution<T>(entity: string, op: string, fn: () => T): T {
  if (statementObserver() === undefined) return fn();
  return storage.run({ entity, op }, fn);
}

/**
 * The innermost enclosing pair, or `undefined` outside every scope — hand-written SQL, a migration,
 * a health probe, the job queue's own statements. Read by the two funnels when an observer is
 * installed, and by nothing else: a diagnostic reads `StatementEvent.attribution`, which is this
 * same answer captured at the moment the statement settled.
 */
export function statementAttribution(): StatementAttribution | undefined {
  return storage.get();
}
