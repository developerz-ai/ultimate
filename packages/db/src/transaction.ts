// Single responsibility: transaction scope. The open `DbTx` rides an AsyncLocalStorage rather
// than a parameter so `ctx.jobs.enqueue()` can write its outbox row on the caller's connection —
// the transactional outbox is only atomic because `currentTx()` finds this store. Nesting maps
// to SAVEPOINTs, so an inner failure never silently aborts the outer unit of work.

import { AsyncLocalStorage } from 'node:async_hooks';
import { nanoid } from '@ultimat3/core';
import { baseClient, type DbClient, type DbConnection, isReservable } from './client';
import { raw, type SqlFragment } from './sql';

export interface DbTx extends DbClient {
  readonly id: string;
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

function makeTx(id: string, connection: DbClient, undos: (() => void)[]): DbTx {
  return {
    id,
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
  const tx = makeTx(`${outer.tx.id}/${name}`, outer.connection, undos);
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

export async function withTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const outer = storage.getStore();
  if (outer !== undefined) return runNested(outer, fn);

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
  const tx = makeTx(`tx_${nanoid(12)}`, connection, undos);

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
