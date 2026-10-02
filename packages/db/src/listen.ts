// Single responsibility: the LISTEN seam — the one capability a pooled statement cannot carry. A
// subscription is a property of a SESSION, and a pooled client has none to name: the next
// statement runs on another connection. So the client holds one connection of its own for it,
// outside the pool, and this file is the shape both drivers answer with.

import { DbError } from './errors';

/** One live `LISTEN`. Idempotent: a second `unlisten()` is the first one's promise. */
export interface DbSubscription {
  unlisten(): Promise<void>;
}

export interface ListeningClient {
  /**
   * `LISTEN <channel>` on a connection this client owns for it — never one out of the pool.
   *
   * `onListening` fires every time the subscription is (re-)established: once when this resolves,
   * and again after the driver has re-dialled a connection that died. A notification sent while
   * it was down is LOST — Postgres queues nothing for a session that is gone — so a caller that
   * must not miss one re-reads its source of truth there.
   *
   * Not through a transaction-pooling proxy (PgBouncer `pool_mode = transaction`): the `LISTEN`
   * lands on a server connection the proxy takes back at once, and nothing is ever delivered.
   * This resolves all the same; only a notification that arrives proves the path.
   */
  listen(
    channel: string,
    onNotify: (payload: string) => void,
    onListening?: () => void,
  ): Promise<DbSubscription>;
}

export function canListen(client: object): client is ListeningClient {
  return typeof (client as Partial<ListeningClient>).listen === 'function';
}

/** What `LISTEN` takes unquoted: a channel is an identifier, and Postgres truncates past 63. */
const CHANNEL = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Refused before it reaches a driver: PGlite quotes the name and `Bun.SQL` validates it, and two
 * drivers reading one string two ways is a channel that works under `x dev` and not in production.
 * `X_SQL_UNSAFE`, the code an identifier that cannot be spliced already answers with
 * (`identifierUnsafe`): the argument is the fix, never the database's reachability.
 */
export function assertListenChannel(channel: string): void {
  if (CHANNEL.test(channel)) return;
  throw new DbError({
    code: 'X_SQL_UNSAFE',
    cause: 'the LISTEN channel is not a lower-case identifier of at most 63 characters',
    fix: "pass a channel matching [a-z_][a-z0-9_]*, e.g. client.listen('x_jobs_wake', onNotify)",
  });
}

/** The driver has no `listen` — a fake, or a runtime older than the one this package requires. */
export function listenUnsupported(driver: string): DbError {
  return new DbError({
    code: 'X_DB_UNAVAILABLE',
    cause: `${driver} has no listen(), so this client cannot hold a LISTEN`,
    fix: 'bun upgrade   # Bun.SQL.listen ships with the Bun this package requires (>= 1.4.0)',
  });
}
