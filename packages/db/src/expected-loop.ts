// Single responsibility: the one way to declare that a loop of statements is deliberate, so a
// statement-level diagnostic reports the loops nobody argued for and stays quiet about the rest.
// A scope with a written reason — never a comment pragma and never a config list of exempt call
// sites (axiom 1), because both put the argument somewhere other than the loop it defends.

// The reason has to outlive every `await` inside the scope and a module-scope variable would be
// shared by two concurrent loops, so it needs an async context — opened through core's one lazy
// seam rather than a `node:async_hooks` construction here, which threw at module EVALUATION in a
// browser bundle (the bundler stubs the module to `{}`) and took every importer of `@ultimat3/db`
// with it.
import { assert, asyncContext } from '@ultimat3/core';

const storage = asyncContext<string>('the expected-loop reason');

/**
 * Run `fn` with every statement it issues — at any depth, across every `await` — marked expected
 * and carrying `reason`. The reason rides on the `StatementEvent` (`expected`), so a diagnostic
 * that buffers a request's statements and judges them at the end still holds the argument long
 * after this scope closed.
 *
 * What it suppresses is a **verdict**, not the statements: they are still sent, still observed,
 * still spans on the trace. A detector counting repeats gets the author's reason for this one
 * instead of guessing, and the loop stays visible to everything that measures rather than judges.
 *
 * `reason` is required and non-blank because it *is* the mechanism — an exemption with no argument
 * is a pragma, and the next reader cannot tell a considered loop from a silenced one. Nesting keeps
 * the innermost reason: the closest scope is the one describing this loop.
 *
 * ```ts
 * // one indexed lookup per search field beats one unindexed OR across all of them
 * return expectedQueryLoop('search runs one indexed lookup per field', async () => {
 *   for (const field of fields) hits.push(...(await repo.list({ where: [eq(field, term)] })));
 *   return hits;
 * });
 * ```
 */
export function expectedQueryLoop<T>(reason: string, fn: () => T): T {
  assert(
    reason.trim() !== '',
    'expectedQueryLoop() was given a blank reason, so the loop it silences carries no argument',
    "pass why the loop is optimal: expectedQueryLoop('one indexed lookup per field', fn)",
  );
  return storage.run(reason, fn);
}

/**
 * The innermost enclosing reason, or `undefined` outside every scope — which is every statement in
 * an app that never calls `expectedQueryLoop`. Read by the two funnels when an observer is
 * installed, and by nothing else: a diagnostic reads `StatementEvent.expected`, which is the same
 * answer captured at the moment the statement settled.
 */
export function expectedQueryLoopReason(): string | undefined {
  return storage.get();
}
