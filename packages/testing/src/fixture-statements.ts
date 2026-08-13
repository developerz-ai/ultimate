// The `statements` fixture: every statement the test issues, counted by shape — and a shape that
// repeats past the threshold throws where it happened, so an N+1 fails the test that caused it
// instead of warning in a dev server nobody is watching.
//
// Strict by construction: there is no `strict: true` to remember, because a fixture nobody
// destructured is a fixture nobody built. Opting in is naming `statements` in the test body.

import type { StatementAttribution, StatementEvent, StatementObserver } from '@ultimat3/db';

/** One statement, as this fixture kept it. Bound values are deliberately not retained. */
export interface ObservedStatement {
  /** What it is counted under: `members.findById` when attributed, else its own collapsed text. */
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** The statement as sent, parameters still `$1..$n`. */
  readonly text: string;
  /** The entity and operation that compiled it; absent for hand-written SQL and queue traffic. */
  readonly attribution?: StatementAttribution | undefined;
  /** The `expectedQueryLoop()` reason in force when it was sent, absent outside every such scope. */
  readonly expected?: string | undefined;
}

/** One shape and how often the test issued it. */
export interface StatementShape {
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** Every statement of this shape, expected ones included — this half measures, it never judges. */
  readonly count: number;
}

/**
 * `Disposable`: the observer seam is process-global, so the fixture hands back whatever it found —
 * the state, not a fixed default, exactly as `network` and `runJobs` do.
 */
export interface TestStatements extends Disposable {
  /** Every statement issued since the fixture was built, in order. */
  all(): readonly ObservedStatement[];
  /** How many of one shape, or of everything when asked with no fingerprint. */
  count(fingerprint?: string): number;
  /** Shapes seen, most repeated first, ties by fingerprint — a stable list to assert against. */
  shapes(): readonly StatementShape[];
}

/** The live tally behind a `StatementShape`: what it measures, and what it judges. */
interface ShapeTally {
  readonly fingerprint: string;
  readonly kind: 'read' | 'write';
  /** Every statement of this shape. */
  count: number;
  /** The ones no `expectedQueryLoop()` scope covered — the only ones a verdict may count. */
  unexpected: number;
  /** Whether this shape has already thrown. The flag, not the count, so it throws exactly once. */
  failed: boolean;
}

/**
 * Install the strict detector for the length of one test.
 *
 * Three rules, each load-bearing and each different from `x dev`'s ledger for a stated reason.
 *
 * **The unit of work is the test, not the request.** The ledger keys its tally on the `Ctx` object
 * and ignores a statement issued outside a request; a unit test calls `posts.findById(id)` with no
 * request anywhere, which is exactly the loop it was written to catch — so this counts every
 * statement from the moment the fixture is built until it is disposed, whatever context it was
 * issued in.
 *
 * **The verdict counts only unexpected statements, the measurements count all of them.** An
 * `expectedQueryLoop(reason, fn)` scope is the one way to declare a loop deliberate (there is no
 * flag here and no second suppression), and it suppresses the *verdict* — the statements are still
 * sent, still observed, and still reported by `count()` and `shapes()`, because a test asserting
 * "this page issues two statements" must not see a different number depending on who declared what.
 *
 * **It throws where the loop happened, once per shape.** `@ultimat3/db`'s seam deliberately lets a
 * throw from `onStatement` propagate to whoever ran the statement, which is what makes the failing
 * line the loop's own line rather than a summary at teardown. Once a shape has thrown it keeps
 * counting silently: a test that catches the error gets one failure at the statement that crossed
 * the threshold, not one per statement after it, and `shapes()` still reports the whole loop. The
 * consequence worth knowing is the same one Bullet's `raise` has — a body that swallows every error
 * swallows this one too, and `shapes()` is what names the loop in that test.
 *
 * The threshold is `@ultimat3/entity`'s `N_PLUS_ONE_THRESHOLD` and there is no knob: a loop that
 * fails a test and a loop that warns in `x dev` have to be the same loop.
 */
export async function createTestStatements(): Promise<TestStatements> {
  // Imported on demand, like every other fixture factory here: a `packages/core` test that never
  // names `statements` must not load the database layer or the entity registry to run.
  const db = await import('@ultimat3/db');
  const { N_PLUS_ONE_THRESHOLD, nPlusOne } = await import('@ultimat3/entity');
  // Captured before the overwrite: the seam holds one observer, not a list, so an outer diagnostic
  // is displaced for the length of this test and put back after it.
  const previous = db.statementObserver();

  const seen: ObservedStatement[] = [];
  const tallies = new Map<string, ShapeTally>();

  const observer: StatementObserver = {
    onStatement(event: StatementEvent): void {
      const fingerprint = db.statementFingerprint(event);
      const kind = db.statementKind(event.text);
      seen.push({
        fingerprint,
        kind,
        text: event.text,
        attribution: event.attribution,
        expected: event.expected,
      });
      let tally = tallies.get(fingerprint);
      if (tally === undefined) {
        tally = { fingerprint, kind, count: 0, unexpected: 0, failed: false };
        tallies.set(fingerprint, tally);
      }
      tally.count += 1;
      if (event.expected !== undefined) return;
      // A statement that threw is still a statement: fifty identical timeouts are still a loop.
      tally.unexpected += 1;
      if (tally.failed || tally.unexpected < N_PLUS_ONE_THRESHOLD) return;
      tally.failed = true;
      // `@ultimat3/entity`'s error, never one composed here: the `fix:` names the `preload` the
      // schema's own relations spell, and a second answer to "what ends this loop" would be one
      // the schema never agreed to.
      throw nPlusOne({
        kind,
        subject: fingerprint,
        count: tally.unexpected,
        entity: event.attribution?.entity,
        op: event.attribution?.op,
      });
    },
  };
  db.setStatementObserver(observer);

  return {
    all: (): readonly ObservedStatement[] => [...seen],
    count: (fingerprint?: string): number =>
      fingerprint === undefined ? seen.length : (tallies.get(fingerprint)?.count ?? 0),
    shapes: (): readonly StatementShape[] =>
      [...tallies.values()]
        .map(({ fingerprint, kind, count }) => ({ fingerprint, kind, count }))
        .sort((left, right) =>
          left.count === right.count
            ? left.fingerprint.localeCompare(right.fingerprint)
            : right.count - left.count,
        ),
    [Symbol.dispose]: (): void => {
      db.setStatementObserver(previous);
    },
  };
}
