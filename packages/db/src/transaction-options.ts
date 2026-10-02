// Single responsibility: what a transaction scope is ASKED for and what it hands back — the `DbTx`
// handle, `TransactionOptions`, and the `BEGIN` text those options spell. Split from
// `transaction.ts` at the file-size rule; the scope itself (pin, savepoints, COMMIT) stays there.

import type { Random } from '@ultimat3/core';
import type { DbClient } from './client';
import { isolationLevelInvalid } from './errors';

export interface DbTx extends DbClient {
  readonly id: string;
  /**
   * The client this transaction was **opened on** — `options.client`, or `baseClient()`. Not the
   * reservation the statements run on: what a caller needs to know is which database and which
   * pool this scope belongs to, and the pin is an implementation detail of that.
   *
   * It exists because the answer was unanswerable from above. `@ultimat3/entity`'s repositories
   * can be pinned to a specific client (`database(shard)`), and a pinned repository inside
   * `withTransaction` sends its statements to *its own pool* while the `BEGIN` sits on a
   * connection this scope reserved — so the write commits immediately and survives the rollback,
   * and reads inside the transaction cannot see it. `withTransaction(fn, { client: shard })` does
   * not fix it either: the transaction runs on a *reservation* of the shard and the repository
   * still sends to the pool. With nothing to compare against, tier 2's only honest answer was to
   * refuse (`X_REPO_CLIENT_PINNED`). `tx.origin === thePinnedClient` turns that refusal into the
   * case working — the repository joins its own shard's transaction — and leaves the refusal for
   * what it should always have been: a genuine mix of two databases in one scope.
   *
   * A nested scope reports the root's, because a SAVEPOINT belongs to the transaction that opened.
   */
  readonly origin: DbClient;
  /**
   * Fired in reverse registration order when this scope rolls back. Never on commit, and never
   * when the answer to COMMIT was lost: the write it would undo may be durable.
   */
  onRollback(undo: () => void): void;
  /**
   * Fired in registration order once the ROOT transaction has COMMITTED — never on rollback, and
   * never when the answer to COMMIT was lost (`X_DB_COMMIT_UNKNOWN`). A
   * nested scope's effects are handed to its parent on `RELEASE` and dropped on `ROLLBACK TO`, so
   * nothing fires for a write that is not durable. What a change feed, a cache purge or a dev row
   * observer needs: reporting a write before COMMIT reports rows a rollback then erases. An effect
   * that throws is swallowed — the transaction already committed, and nothing can un-commit it.
   */
  onCommit(effect: () => void): void;
}

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export interface TransactionOptions {
  readonly isolation?: IsolationLevel | undefined;
  readonly readOnly?: boolean | undefined;
  /** Only meaningful with `serializable` + `readOnly`; lets Postgres wait instead of retrying. */
  readonly deferrable?: boolean | undefined;
  /** Override the ambient pool — tests and `x db branch` run against a specific client. */
  readonly client?: DbClient | undefined;
  /**
   * Extra attempts after a `40001`/`40P01`, and **only** after one. Default 0, so adding the option
   * changed no existing transaction's behaviour (axiom 1) — a retry that ran without being asked
   * for would silently double every non-idempotent handler in the framework.
   *
   * Opt in wherever `isolation: 'serializable'` is set: under SERIALIZABLE a serialization failure
   * is normal traffic, not an exception, and until this existed a payments team choosing it for
   * ledger correctness got ~3% of transactions surfacing to the user as "cannot reach the
   * database" with no way to write their own retry, because nothing distinguished `40001` from a
   * dead socket.
   *
   * **`fn` re-runs from the top, so it must be idempotent** — the same contract `job.handle` has.
   * `onRollback` undos fire before each retry, in reverse registration order.
   *
   * Each re-run waits first (`transaction-backoff.ts`). A budget of 0 waits not at all.
   */
  readonly retry?: number | undefined;
  /**
   * The wait between attempts, and the roll behind its jitter. Injected for one reason — a schedule
   * provable only by waiting for it is a schedule no test pins — and production passes neither.
   * They are only ever read when `retry` is 1 or more.
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly random?: Random | undefined;
  /**
   * How long a NESTED scope waits for a sibling scope to finish before it may open, in
   * milliseconds. Sibling scopes under one parent run one after the other, so a body that awaits
   * a sibling started after it waits for itself; past this the waiting call rejects with
   * `X_DB_SIBLING_SCOPE_TIMEOUT` instead of hanging. Default `SIBLING_SCOPE_WAIT_MS` (30 s); `0`
   * waits without a deadline. Read only by a nested scope — the outermost one has no sibling.
   */
  readonly siblingWaitMs?: number | undefined;
}

/**
 * The SQL for one isolation level, RE-DERIVED from the closed set rather than built out of the
 * value — the same rule `pg-sql.ts` follows for `asc|desc`, and for the same reason: `BEGIN` takes
 * no parameters, so this is one of the two statements here built as text, and a level spliced into
 * it is whatever the caller passed. `isolation` is typed, and a type is not a runtime guard: the
 * value reaches `withTransaction` from an app's config, a JSON body or a CLI flag —
 * `{ isolation: 'read committed; drop table x; --' }` became exactly that statement, and a
 * non-string became an uncoded `TypeError` inside a template literal.
 *
 * The `default` arm is `never`, so a fourth member added to `IsolationLevel` with no SQL beside it
 * is a type error here rather than a refusal at runtime.
 */
const isolationMode = (declared: IsolationLevel): string => {
  switch (declared) {
    case 'read committed':
      return 'ISOLATION LEVEL READ COMMITTED';
    case 'repeatable read':
      return 'ISOLATION LEVEL REPEATABLE READ';
    case 'serializable':
      return 'ISOLATION LEVEL SERIALIZABLE';
    default: {
      const unhandled: never = declared;
      throw isolationLevelInvalid(unhandled);
    }
  }
};

export function beginStatement(options: TransactionOptions): string {
  const modes: string[] = [];
  if (options.isolation !== undefined) modes.push(isolationMode(options.isolation));
  if (options.readOnly === true) modes.push('READ ONLY');
  if (options.deferrable === true) modes.push('DEFERRABLE');
  return modes.length === 0 ? 'BEGIN' : `BEGIN ${modes.join(' ')}`;
}
