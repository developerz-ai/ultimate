// Single responsibility: transaction scope. The open `DbTx` rides an AsyncLocalStorage rather
// than a parameter so `ctx.jobs.enqueue()` can write its outbox row on the caller's connection —
// the transactional outbox is only atomic because `currentTx()` finds this store. Nesting maps
// to SAVEPOINTs, so an inner failure never silently aborts the outer unit of work.

import { AsyncLocalStorage } from 'node:async_hooks';
import { assert, nanoid } from '@ultimat3/core';
import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { serializationExhausted } from './errors';
import { raw, type SqlFragment } from './sql';
import { isRetryableState } from './sqlstate';

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
  /** Fired in reverse registration order when this scope rolls back. Never on commit. */
  onRollback(undo: () => void): void;
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
   */
  readonly retry?: number | undefined;
}

interface TxState {
  readonly tx: DbTx;
  readonly connection: DbClient;
  readonly undos: (() => void)[];
  /** Shared by reference across nesting levels so savepoint names never collide. */
  readonly savepoints: { value: number };
}

const storage = new AsyncLocalStorage<TxState>();

/** The open transaction, or `undefined` outside one. `@ultimat3/jobs` calls this per enqueue. */
export function currentTx(): DbTx | undefined {
  return storage.getStore()?.tx;
}

export function beginStatement(options: TransactionOptions): string {
  const modes: string[] = [];
  if (options.isolation !== undefined) {
    modes.push(`ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
  }
  if (options.readOnly === true) modes.push('READ ONLY');
  if (options.deferrable === true) modes.push('DEFERRABLE');
  return modes.length === 0 ? 'BEGIN' : `BEGIN ${modes.join(' ')}`;
}

function makeTx(id: string, connection: DbClient, undos: (() => void)[], origin: DbClient): DbTx {
  return {
    id,
    origin,
    query: <T>(fragment: SqlFragment) => connection.query<T>(fragment),
    one: <T>(fragment: SqlFragment) => connection.one<T>(fragment),
    execute: (fragment: SqlFragment) => connection.execute(fragment),
    onRollback: (undo: () => void) => {
      undos.push(undo);
    },
  };
}

/** Undo hooks are best-effort: one throwing must not mask the error that caused the rollback. */
function runUndos(undos: readonly (() => void)[]): void {
  for (let index = undos.length - 1; index >= 0; index -= 1) {
    try {
      undos[index]?.();
    } catch {
      // swallowed deliberately — see above
    }
  }
}

async function runNested<T>(outer: TxState, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  outer.savepoints.value += 1;
  const name = `x_sp_${outer.savepoints.value}`;
  const undos: (() => void)[] = [];
  const tx = makeTx(`${outer.tx.id}/${name}`, outer.connection, undos, outer.tx.origin);
  // `SAVEPOINT` and `RELEASE` are deliberately uncaught: a savepoint that was never taken means
  // this scope never opened, and a release that failed means its work is not durable in the outer
  // one. Both are the caller's failure to see — swallowing either would run the rest of the unit
  // of work against a transaction that is not the one it thinks it is in.
  await outer.connection.execute(raw(`SAVEPOINT ${name}`));
  try {
    const result = await storage.run({ ...outer, tx, undos }, () => fn(tx));
    await outer.connection.execute(raw(`RELEASE SAVEPOINT ${name}`));
    // The nested scope committed into an outer one that can still roll back, so its undos
    // must survive: hand them to the parent rather than dropping them.
    outer.undos.push(...undos);
    return result;
  } catch (error) {
    // Best-effort, exactly like the root's ROLLBACK: the savepoint is already gone when the
    // failure was the connection itself, and the caller needs the error that caused the rollback,
    // never the rollback's own.
    await outer.connection.execute(raw(`ROLLBACK TO SAVEPOINT ${name}`)).catch(() => undefined);
    runUndos(undos);
    throw error;
  }
}

/**
 * One attempt at a root transaction: its own pin, its own BEGIN, its own undo list. Extracted so
 * the retry loop can re-run it whole — a retry that reused the pin would be re-running against a
 * connection whose transaction is already gone.
 */
async function runRoot<T>(fn: (tx: DbTx) => Promise<T>, options: TransactionOptions): Promise<T> {
  const client = options.client ?? baseClient();
  // A pooled BEGIN that lands on a different physical connection than the statements after it is
  // not a transaction at all, so a reservable client pins one connection for the whole scope.
  // Held by a `using` declaration rather than a `finally`, because a `finally` only covers what
  // someone remembered to put in its `try`: BEGIN used to sit above the block, so a rejected BEGIN
  // returned the pin to nobody — on PGlite, the single session's turn with it, wedging every later
  // statement in the process. The declaration covers every exit, including the ones nobody wrote.
  using reserved: DbConnection | undefined = isReservable(client)
    ? await client.reserve()
    : undefined;
  const connection: DbClient = reserved ?? client;
  const undos: (() => void)[] = [];
  const tx = makeTx(`tx_${nanoid(12)}`, connection, undos, client);

  try {
    await connection.execute(raw(beginStatement(options)));
    const state: TxState = { tx, connection, undos, savepoints: { value: 0 } };
    const result = await storage.run(state, () => fn(tx));
    await connection.execute(raw('COMMIT'));
    return result;
  } catch (error) {
    // Best-effort: the caller needs the original failure, never the rollback's. A BEGIN that
    // itself failed opened nothing, so this ROLLBACK is a no-op the server answers with a notice.
    await connection.execute(raw('ROLLBACK')).catch(() => undefined);
    runUndos(undos);
    throw error;
  }
}

export async function withTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const outer = storage.getStore();
  if (outer !== undefined) {
    // A nested scope is a SAVEPOINT, and a savepoint cannot survive the thing `retry` exists for:
    // measured against Postgres 17, a `40001` aborts the **whole** transaction, so the
    // `ROLLBACK TO SAVEPOINT` that would start attempt two answers `25P01 ROLLBACK TO SAVEPOINT
    // can only be used in transaction blocks`. Re-running the inner body would also be re-running
    // it against reads the outer scope took before the race — the retry has to own the BEGIN.
    // Refused rather than ignored: a budget silently dropped is worse than one refused, because
    // the author believes they have it.
    assert(
      options.retry === undefined || options.retry === 0,
      'withTransaction({ retry }) inside another transaction: a nested scope is a SAVEPOINT, and a serialization failure aborts the whole transaction, so there is nothing left to retry into',
      "move the retry to the OUTERMOST withTransaction — withTransaction(fn, { retry: 3, isolation: 'serializable' }) — and drop it here",
    );
    return runNested(outer, fn);
  }

  const attempts = (options.retry ?? 0) + 1;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runRoot(fn, options);
    } catch (error) {
      // Only a lost serialization race, and only that: everything else — a constraint, a timeout, a
      // dead socket, a throw from `fn` itself — is a failure re-running cannot change, and retrying
      // it would turn one error into `retry + 1` of them.
      if (!isRetryableState(error)) throw error;
      // Nobody asked for a retry, so nothing was exhausted: the caller gets the driver's own
      // `X_DB_SERIALIZATION_FAILURE`, whose fix is `withTransaction(fn, { retry: 3 })` — the
      // instruction they actually need. Wrapping it would answer "raise your budget" to someone
      // who has no budget.
      if (attempts === 1) throw error;
      last = error;
    }
  }
  throw serializationExhausted(attempts, last);
}
