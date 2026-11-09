// Single responsibility: the one way to declare a loop of statements deliberate, or a statement a
// whole-table read, so a diagnostic reports only what nobody argued for. A scope with a written
// reason — never a comment pragma nor a config list of exempt call sites (axiom 1): both put the
// argument somewhere other than the statement it defends.

// The reason has to outlive every `await` inside the scope and a module-scope variable would be
// shared by two concurrent loops, so it needs an async context — opened through core's one lazy
// seam rather than a `node:async_hooks` construction here, which threw at module EVALUATION in a
// browser bundle (the bundler stubs the module to `{}`) and took every importer of `@ultimat3/db`
// with it.
import { assert, asyncContext } from '@ultimat3/core';

const storage = asyncContext<string>('the expected-loop reason');

/**
 * Run `fn` with every statement it issues — at any depth, across every `await` — marked expected
 * and carrying `reason`. The reason rides on the `DbStatementEvent` (`expected`), so a diagnostic
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
 * an app that never calls `expectedQueryLoop`. Read by `traceStatement` while `db.statement`
 * has a subscriber, and by nothing else: a subscriber reads `DbStatementEvent.expected`, which is the same
 * answer captured at the moment the statement settled.
 */
export function expectedQueryLoopReason(): string | undefined {
  return storage.get();
}

const scans = asyncContext<string>('the expected-seq-scan reason');

/**
 * Run `fn` with every statement it issues marked as one that must read its table whole, carrying
 * `reason`. The plan sweep `x exercise` runs reads it off each statement it saw, and lists the
 * statement as exempt with the reason instead of `X_QUERY_UNINDEXED` — for a hand-written report
 * over every row, never for a lookup that lacks its index. A table that is small by nature says so
 * once, on the entity: `entity('plans', { scan: '<why>' })`. Same shape as `expectedQueryLoop`:
 * required, non-blank, innermost wins, and a verdict suppressed — the statement still runs.
 *
 * ```ts
 * await expectedSeqScan('the nightly digest reads every subscription once', () =>
 *   db().query(sql`select id, email from subscriptions where active`),
 * );
 * ```
 */
export function expectedSeqScan<T>(reason: string, fn: () => T): T {
  assert(
    reason.trim() !== '',
    'expectedSeqScan() was given a blank reason, so the scan it exempts carries no argument',
    "pass why the statement must read the whole table: expectedSeqScan('the nightly digest reads every row once', fn)",
  );
  return scans.run(reason, fn);
}

/** The innermost `expectedSeqScan` reason in force, or `undefined` outside every scope. */
export function expectedSeqScanReason(): string | undefined {
  return scans.get();
}
