// Single responsibility: the seam a diagnostic hangs statements off. One installed observer,
// process-wide, read through one accessor — so the funnels every statement already passes through
// pay a single `undefined` check when nothing is installed (axiom 6). Nothing here knows what an
// entity, a request or a span is: `db` is tier 1 and the detector that consumes this is tier 5.

/**
 * What the layer that compiled the statement knows and the driver cannot: which entity and which
 * repository operation. Threaded by `@ultimat3/entity` (tier 2, so importing this is downward),
 * absent for hand-written SQL, a migration or a health probe. It is the difference between
 * "50× `select … where id = $1`" and "50× `findById` on `members`" in a diagnostic's report.
 */
export interface StatementAttribution {
  /** Entity name as declared, e.g. `members` — never a table name. */
  readonly entity: string;
  /** Repository operation that compiled the statement, e.g. `findById`. */
  readonly op: string;
}

/** One settled statement. Emitted after it resolved or rejected, never before it was sent. */
export interface StatementEvent {
  /** The statement as sent, parameters still as `$1..$n`. Safe to log; values are separate. */
  readonly text: string;
  /** Bound parameters, in order. May carry user data — a consumer that logs must redact. */
  readonly values: readonly unknown[];
  /** Wall time from send to settle, from `performance.now()`. */
  readonly durationMs: number;
  /** Rows returned by a read, rows affected by a write, `0` when the statement threw. */
  readonly rows: number;
  /** The rejection, already wrapped as `X_DB_UNAVAILABLE` by the funnel. */
  readonly error?: unknown;
  readonly attribution?: StatementAttribution | undefined;
}

/**
 * A diagnostic. `onStatement` runs synchronously on the caller's stack once the statement has
 * settled, so it must not await anything and must not issue SQL — a statement issued from here
 * re-enters the funnel and observes itself.
 *
 * A throw propagates to whoever ran the statement, deliberately: strict test mode is an observer
 * that fails the test the N+1 happened in, and swallowing here would make that impossible. An
 * observer that only reports must therefore not throw.
 */
export interface StatementObserver {
  onStatement(event: StatementEvent): void;
}

let installed: StatementObserver | undefined;

/**
 * Install the process-wide observer. `setStatementObserver(undefined)` uninstalls, which is the
 * production state and the state every test must leave behind. The `setDbClient` shape, for the
 * same reason: the thing being replaced is ambient, so the seam is a setter and not a parameter
 * threaded through `db()`, `withTransaction()` and both drivers.
 *
 * One observer, not a list — a second registration replaces the first. A fan-out array would make
 * "which diagnostic saw this statement" order-dependent, and the one consumer that needs several
 * (the dev server) composes them itself, in its own order, where that order is reviewable.
 */
export function setStatementObserver(observer: StatementObserver | undefined): void {
  installed = observer;
}

/**
 * The installed observer, or `undefined` when there is none. Read once per statement and guarded
 * at the call site rather than notified through a wrapper, so an uninstalled seam costs one
 * property read and one branch — no event object is allocated for nobody to receive.
 */
export function statementObserver(): StatementObserver | undefined {
  return installed;
}
