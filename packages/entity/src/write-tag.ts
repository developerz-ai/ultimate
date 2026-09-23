// A keyed write names itself in the write-ahead log. The Postgres driver opens the transaction a
// keyed request's write lands in with `pg_logical_emit_message(true, WRITE_ORIGIN_WAL_PREFIX,
// <digest>)`, and `@ultimat3/realtime`'s replication stream names every change after it with that
// digest — which is how a `records` frame produced by the replicator, in another process, still
// tells the page that wrote it that this is its own echo. The in-process row observer reads the
// same fact off the request scope and needs none of this.

import { currentWriteOrigin, WRITE_ORIGIN_WAL_PREFIX } from '@ultimat3/core';
import { currentTx, type DbClient, type DbTx, db, sql, withTransaction } from '@ultimat3/db';

/** Transactions this process already opened with the message: one per transaction is enough. */
const tagged = new WeakSet<DbTx>();

/**
 * Whether this database lets the app's role emit the message. Asked once per process and
 * remembered only once answered: a role without `EXECUTE` (a managed service may revoke it) must
 * cost the page its echo match, never the write — so the answer is read BEFORE the first emit
 * rather than learned from a failed one, which would already have aborted the caller's transaction.
 */
let emits: Promise<boolean> | undefined;

/**
 * By name, across overloads: Postgres 17 added a fourth parameter (`flush`, defaulted), so a probe
 * naming the three-argument signature answered "no such function" there while the call below works
 * on every version from 14 up. Measured on 17-alpine.
 */
const CAN_EMIT = sql`select exists (select 1 from pg_catalog.pg_proc where proname = 'pg_logical_emit_message' and has_function_privilege(oid, 'execute')) as "ok"`;

function canEmit(client: DbClient): Promise<boolean> {
  if (emits === undefined) {
    const asked = client.one<{ ok: unknown }>(CAN_EMIT).then((row) => row?.ok === true);
    emits = asked;
    // A probe that FAILED answered nothing: the next write asks again.
    asked.catch(() => {
      if (emits === asked) emits = undefined;
    });
  }
  return emits.catch(() => false);
}

const emit = (client: DbClient, digest: string): Promise<unknown> =>
  client.query(
    sql`select pg_logical_emit_message(true, ${WRITE_ORIGIN_WAL_PREFIX}::text, ${digest}::text)`,
  );

/**
 * Send `write` so the WAL names the keyed write it belongs to. Outside a keyed request, or on a
 * repository pinned to its own client (which may not join a transaction — `X_REPO_CLIENT_PINNED`),
 * it is `write()` unchanged. Inside an open transaction the message goes first, once. Outside one,
 * the write is wrapped in a transaction of its own, because a message in another transaction names
 * nothing: three more round trips per keyed write, and only for a write a page is waiting on.
 */
export async function taggedWrite<T>(pinned: boolean, write: () => Promise<T>): Promise<T> {
  const digest = currentWriteOrigin();
  if (digest === undefined || pinned) return write();
  const open = currentTx();
  if (!(await canEmit(open ?? db()))) return write();
  if (open !== undefined) {
    if (!tagged.has(open)) {
      await emit(open, digest);
      tagged.add(open);
    }
    return write();
  }
  return withTransaction(async (tx) => {
    await emit(tx, digest);
    tagged.add(tx);
    return write();
  });
}

/** Forget the capability answer. Tests only: a process asks one database once. */
export function resetWriteTag(): void {
  emits = undefined;
}
