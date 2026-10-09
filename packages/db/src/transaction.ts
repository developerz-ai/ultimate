// Single responsibility: transaction scope. The open `DbTx` rides an AsyncLocalStorage rather
// than a parameter so `ctx.jobs.enqueue()` can write its outbox row on the caller's connection —
// the transactional outbox is only atomic because `currentTx()` finds this store. Nesting maps
// to SAVEPOINTs, so an inner failure never silently aborts the outer unit of work.

import { assert, asyncContext, finiteCount, nanoid } from '@ultimat3/core';
import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { DbError, serializationExhausted } from './errors';
import { createTurnQueue, type TurnQueue } from './pglite-turns';
import { markScopeWrote } from './replica-scope';
import { SIBLING_SCOPE_WAIT_MS, siblingTurn } from './sibling-turn';
import { raw, type SqlFragment } from './sql';
import { isRetryableState, sqlState } from './sqlstate';
import { serializationRetryDelayMs } from './transaction-backoff';
import { commitUnknown, siblingScopeTimeout, transactionAborted } from './transaction-errors';
import { beginStatement, type DbTx, type TransactionOptions } from './transaction-options';

interface TxState {
  readonly tx: DbTx;
  readonly connection: DbClient;
  readonly undos: (() => void)[];
  /** This scope's `onCommit` effects; a nested scope hands its own to the parent on RELEASE. */
  readonly commits: (() => void)[];
  /** How the root ended — shared by reference, like `live`. */
  readonly outcome: TxOutcome;
  /** Shared by reference across nesting levels so savepoint names never collide. */
  readonly savepoints: { value: number };
  /**
   * Whether the scope is still OPEN. Shared by reference across nesting for the same reason the
   * savepoint counter is: a SAVEPOINT lives and dies with the root transaction that opened it.
   *
   * Mutable because the store outlives the scope. `AsyncLocalStorage` propagates into every
   * promise chain started inside `fn`, so a statement the app forgot to `await` still finds this
   * store long after COMMIT — and a reader that treats the store's PRESENCE as an open
   * transaction believes a dead one is live.
   */
  readonly live: { value: boolean };
  /** Whether the SERVER has aborted the transaction — shared by reference, like `live`. */
  readonly abort: TxAbort;
  /**
   * One CHILD scope at a time, per scope. Savepoints are a stack on the server: two siblings opened
   * under `Promise.all` interleaved `SAVEPOINT x_sp_1, SAVEPOINT x_sp_2`, and `RELEASE x_sp_1`
   * destroyed `x_sp_2` with it — the second scope's work released into the first's, its own
   * `RELEASE` answered `3B001`, and a `ROLLBACK TO x_sp_1` undid a sibling that had reported
   * success. Each scope owns its own queue, so a child of the scope holding the turn never waits
   * behind its parent, and the open savepoints are always one chain.
   */
  readonly children: TurnQueue;
  /** The savepoint of the child holding that turn — what a sibling that gave up waiting names. */
  readonly holder: { value: string | undefined };
}

/**
 * The first statement the server refused inside the transaction, kept until a `ROLLBACK TO
 * SAVEPOINT` undoes it. Postgres aborts the whole transaction on ANY statement error; every later
 * statement answers `25P02`, and `COMMIT` answers `ROLLBACK` with no error at all.
 */
type TxAbort = { value: boolean; first: unknown };

/**
 * Only a failure that carries a SQLSTATE: that is the server refusing a statement it READ, which is
 * what aborts. A refusal raised before the send (a ragged array parameter) left the transaction
 * untouched, and a dead socket is reported by the COMMIT that follows it.
 */
function noteFailure(abort: TxAbort, error: unknown): void {
  if (abort.value || sqlState(error) === undefined) return;
  abort.value = true;
  abort.first = error;
}

// Core's one lazy seam, never a construction here: a module-scope `new` threw at EVALUATION in a
// browser bundle, where the bundler stubs `node:async_hooks` to `{}`, and took every importer of
// `@ultimat3/db` with it. `get()` still answers `undefined` outside a scope, so the server pays
// nothing for the deferral.
const storage = asyncContext<TxState>('a database transaction');

/** The open transaction, or `undefined` outside one. `@ultimat3/jobs` calls this per enqueue. */
export function currentTx(): DbTx | undefined {
  return storage.get()?.tx;
}

/**
 * Run `fn` outside any transaction this async context carries: inside it `currentTx()` is
 * `undefined` and `db()` is the pool. For work that must never join a caller's transaction even
 * when it was STARTED inside one — `@ultimat3/jobs` runs every job body under it, because a worker
 * started inside a transaction scope handed each job that transaction, long committed, and an
 * enqueue from the body staged into its dead outbox.
 */
export function outsideTransaction<R>(fn: () => R): R {
  return storage.exit(fn);
}

/**
 * The connection the transaction still OPEN on this async context runs on, or `undefined`. A
 * different question from `currentTx() !== undefined`, which only says a store is present — and the
 * store survives the scope. The one reader is `pglite.ts`'s `run()`, where the answer decides
 * whether a statement may skip the single session's turn queue; skipping it on a *closed*
 * transaction is how a straggler landed inside whichever unit of work held the connection next.
 * `currentTx()` deliberately still answers with the dead handle: its statements go through the
 * reservation, whose own `held` fence already re-queues them.
 *
 * The CONNECTION, never a boolean: "is any transaction open" let an autocommit statement on
 * client A, issued inside a transaction on client B, skip A's queue and run inside A's own open
 * transaction — rolled back with it. The reader asks whether the connection is one of its own.
 */
export function liveTxConnection(): DbClient | undefined {
  const state = storage.get();
  return state?.live.value === true ? state.connection : undefined;
}

/**
 * How the ROOT transaction ended, shared by every nested scope. An effect registered by a straggler
 * — a promise chain `fn` forgot to await, still inside the store after the scope closed — runs at
 * once after a COMMIT and is dropped after a ROLLBACK, rather than waiting on a list nobody reads.
 */
type TxOutcome = { value: 'open' | 'committed' | 'rolled-back' | 'unknown' };

/** One statement on the scope's connection, its refusal remembered before the caller can drop it. */
async function watched<T>(abort: TxAbort, sent: Promise<T>): Promise<T> {
  try {
    return await sent;
  } catch (error) {
    noteFailure(abort, error);
    throw error;
  }
}

function makeTx(
  id: string,
  connection: DbClient,
  undos: (() => void)[],
  commits: (() => void)[],
  origin: DbClient,
  outcome: TxOutcome,
  abort: TxAbort,
): DbTx {
  return {
    id,
    origin,
    query: <T>(fragment: SqlFragment) => watched(abort, connection.query<T>(fragment)),
    one: <T>(fragment: SqlFragment) => watched(abort, connection.one<T>(fragment)),
    execute: (fragment: SqlFragment) => watched(abort, connection.execute(fragment)),
    onRollback: (undo: () => void) => {
      undos.push(undo);
    },
    onCommit: (effect: () => void) => {
      if (outcome.value === 'committed') runCommits([effect]);
      else if (outcome.value === 'open') commits.push(effect);
    },
  };
}

const isAborted = (error: unknown): boolean =>
  error instanceof DbError && error.code === 'X_DB_TRANSACTION_ABORTED';

/** Commit effects are best-effort too: the transaction is durable, and one throwing must not undo that. */
function runCommits(commits: readonly (() => void)[]): void {
  for (const effect of commits) {
    try {
      effect();
    } catch {
      // swallowed deliberately — see above
    }
  }
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

async function runNested<T>(
  outer: TxState,
  fn: (tx: DbTx) => Promise<T>,
  waitMs: number,
): Promise<T> {
  // Held to the end of this function, on every exit: the next sibling's SAVEPOINT is sent only
  // after this scope's RELEASE or ROLLBACK TO has been answered. Under a deadline, because a body
  // awaiting a sibling queued behind it is a cycle (`sibling-turn.ts`).
  using _turn = await siblingTurn(outer.children, waitMs, () =>
    siblingScopeTimeout(outer.tx.id, outer.holder.value, waitMs),
  );
  const { abort } = outer;
  // Named, rather than left to the SAVEPOINT below to fail with `25P02`: the statement that broke
  // the transaction is the one the caller caught, and it is the only one worth reading.
  if (abort.value) throw transactionAborted(abort.first);
  outer.savepoints.value += 1;
  const name = `x_sp_${outer.savepoints.value}`;
  outer.holder.value = name;
  const undos: (() => void)[] = [];
  const commits: (() => void)[] = [];
  const tx = makeTx(
    `${outer.tx.id}/${name}`,
    outer.connection,
    undos,
    commits,
    outer.tx.origin,
    outer.outcome,
    abort,
  );
  // `SAVEPOINT` and `RELEASE` are deliberately uncaught: a savepoint that was never taken means
  // this scope never opened, and a release that failed means its work is not durable in the outer
  // one. Both are the caller's failure to see — swallowing either would run the rest of the unit
  // of work against a transaction that is not the one it thinks it is in.
  await watched(abort, outer.connection.execute(raw(`SAVEPOINT ${name}`)));
  try {
    const children = createTurnQueue();
    const scope: TxState = { ...outer, tx, undos, commits, children, holder: { value: undefined } };
    const result = await storage.run(scope, () => fn(tx));
    // The body swallowed a failed statement. RELEASE would answer `25P02`; the scope is rolled
    // back below instead, which is the one thing that makes the OUTER transaction usable again.
    if (abort.value) throw transactionAborted(abort.first);
    await watched(abort, outer.connection.execute(raw(`RELEASE SAVEPOINT ${name}`)));
    // The nested scope committed into an outer one that can still roll back, so its undos
    // must survive: hand them to the parent rather than dropping them. Its commit effects wait
    // for the ROOT's COMMIT the same way — a released savepoint is not yet durable.
    outer.undos.push(...undos);
    outer.commits.push(...commits);
    return result;
  } catch (error) {
    // The caller still needs the error that caused the rollback, never the rollback's own — but a
    // `ROLLBACK TO` that failed is no longer forgotten. The scope's work was NOT undone, so the
    // root is marked aborted and its COMMIT refuses: committing would store the writes of a scope
    // that just told its caller they were rolled back.
    try {
      await outer.connection.execute(raw(`ROLLBACK TO SAVEPOINT ${name}`));
      // Whatever broke the transaction happened after this savepoint — the SAVEPOINT itself was
      // accepted — so the server has undone it and statements are accepted again.
      abort.value = false;
      abort.first = undefined;
    } catch (rollbackError) {
      if (!abort.value) abort.first = rollbackError;
      abort.value = true;
    }
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
  // A transaction is assumed to write unless it said otherwise, so every read AFTER it in the same
  // `withReplicaReads` scope is the primary's. The pin below already keeps the transaction's own
  // statements off any replica — this is about the rest of the request, which `replica-client.ts`
  // could not otherwise see: `runRoot` sends through a reserved connection, not through the router.
  if (options.readOnly !== true) markScopeWrote();
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
  const commits: (() => void)[] = [];
  const outcome: TxOutcome = { value: 'open' };
  const abort: TxAbort = { value: false, first: undefined };
  const tx = makeTx(`tx_${nanoid(12)}`, connection, undos, commits, client, outcome, abort);
  // Each attempt gets its own state, and therefore its own `live` — a retry re-runs `fn` against a
  // transaction that is genuinely new, so the abandoned attempt's stragglers must read as closed.
  const state: TxState = {
    tx,
    connection,
    undos,
    commits,
    outcome,
    savepoints: { value: 0 },
    live: { value: true },
    abort,
    children: createTurnQueue(),
    holder: { value: undefined },
  };

  let committed = false;
  let commitSent = false;
  try {
    await connection.execute(raw(beginStatement(options)));
    const result = await storage.run(state, () => fn(tx));
    // Refused before the COMMIT is sent: the server would answer it `ROLLBACK` with no error. The
    // funnels read that tag too (`commit-tag.ts`), for an abort this scope's handle never saw.
    if (abort.value) throw transactionAborted(abort.first);
    commitSent = true;
    await connection.execute(raw('COMMIT'));
    // After COMMIT answered, and outside the `catch` below: a failing effect must never be read as
    // a failed transaction and trigger a ROLLBACK of work the server already made durable.
    committed = true;
    outcome.value = 'committed';
    runCommits(commits);
    return result;
  } catch (error) {
    if (committed) throw error;
    // Best-effort: the caller needs the original failure, never the rollback's. A BEGIN that
    // itself failed opened nothing, so this ROLLBACK is a no-op the server answers with a notice.
    await connection.execute(raw('ROLLBACK')).catch(() => undefined);
    // A COMMIT rejected with no SQLSTATE and no ROLLBACK tag never got its answer, so the unit of
    // work may be durable. Neither list runs: see `commitUnknown`.
    if (commitSent && sqlState(error) === undefined && !isAborted(error)) {
      outcome.value = 'unknown';
      throw commitUnknown(error);
    }
    outcome.value = 'rolled-back';
    runUndos(undos);
    throw error;
  } finally {
    // The scope says when it CLOSED, on every exit, because nothing else can: the store it left
    // behind is indistinguishable from a live one, and `liveTxConnection()` tells them apart.
    // Cleared before the `using` pin is given back, so no window exists where a straggler could
    // still be sent direct at a connection this scope no longer owns.
    state.live.value = false;
  }
}

export async function withTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  // Before anything opens. `attempts = retry + 1` turned a negative, fractional or NaN budget into
  // a loop that never ran its body: `fn` was called ZERO times and the caller was handed
  // `X_DB_SERIALIZATION_FAILURE` — "lost its serialization race on all 0 attempts" — for a
  // transaction that was never begun. `Number(process.env.DB_RETRY)` on an unset var is how the
  // NaN arrives, and the nested branch below already refuses a budget it cannot honour.
  assert(
    options.retry === undefined || (Number.isInteger(options.retry) && options.retry >= 0),
    `withTransaction({ retry }) needs a whole number of extra attempts, 0 or more; a budget that is not one opens nothing and runs fn zero times`,
    "pass an integer — withTransaction(fn, { retry: 3, isolation: 'serializable' }) — and parse it before you pass it: Number(process.env.DB_RETRY) is NaN when the variable is unset",
  );
  const siblingWaitMs = finiteCount(
    'withTransaction',
    'siblingWaitMs',
    options.siblingWaitMs ?? SIBLING_SCOPE_WAIT_MS,
  );
  const outer = storage.get();
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
    // The same argument for everything else a SAVEPOINT cannot honour. The isolation level and the
    // access mode were fixed by the root's BEGIN, and a savepoint lives on the root's connection:
    // `{ client: shard }` in here recorded a savepoint on the OUTER database and nothing on the
    // shard, and `{ readOnly: true }` wrapped writes that then committed.
    assert(
      options.isolation === undefined && options.readOnly !== true && options.deferrable !== true,
      'withTransaction({ isolation, readOnly, deferrable }) inside another transaction: a nested scope is a SAVEPOINT in the transaction the outermost BEGIN opened, and its isolation level and access mode cannot change after that',
      "state them on the OUTERMOST withTransaction — withTransaction(fn, { isolation: 'serializable', readOnly: true }) — and drop them here",
    );
    assert(
      options.client === undefined || options.client === outer.tx.origin,
      'withTransaction({ client }) inside a transaction opened on a different client: a nested scope is a SAVEPOINT on the outer connection, so nothing would run on the client named here',
      'open the second database in its own unit of work, outside this one — await withTransaction(fn, { client }) after the outer scope returns — or drop { client } to join the outer transaction',
    );
    return runNested(outer, fn, siblingWaitMs);
  }

  const attempts = (options.retry ?? 0) + 1;
  // `Bun.sleep`, never a `node:timers` import: this is the runtime's own, and `migrate.ts` polls
  // the advisory lock through the same call.
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
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
      // Jittered, and only between attempts. Re-running instantly is what this loop did until
      // 2026-08-23, and it is the deadlock reproduced rather than resolved: both losers wake in the
      // same microsecond, take the same locks in the same order, and one of them loses again — so a
      // budget of 8 was spent inside a single round trip's worth of wall clock. Nothing waits after
      // the LAST attempt: there is nothing behind it to give the contention room for.
      if (attempt < attempts) await sleep(serializationRetryDelayMs(attempt, options.random));
    }
  }
  throw serializationExhausted(attempts, last);
}
