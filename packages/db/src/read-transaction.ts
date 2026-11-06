// Single responsibility: a read inside its own read-only transaction, with transaction-local
// settings applied first. Row security's tenant and a read's statement bound both ride this one
// helper, so a setting meant for one read can never outlive it on a pooled connection.

import { assert } from '@ultimat3/core';
import type { DbClient } from './client';
import { type LocalSettings, readLocal, setLocal } from './local-settings';
import { currentTx, withTransaction } from './transaction';
import type { DbTx } from './transaction-options';

export interface ReadTransactionOptions {
  /** Applied through `setLocal`, before `fn` runs. */
  readonly settings?: LocalSettings | undefined;
  /** The client to open on — row security's standby read passes the replica. Default the pool. */
  readonly client?: DbClient | undefined;
}

/**
 * `withTransaction(fn, { readOnly: true, client })`, then `setLocal`. The server refuses a write
 * inside it (`25006`), and `readOnly` keeps a `withReplicaReads` scope from being marked as written.
 *
 * Inside an open transaction the access mode is the outer `BEGIN`'s and cannot change, so this
 * joins it: the settings are applied, `fn` runs, and the values read before are put back — the
 * rest of the outer transaction sees what it saw. No savepoint: nothing here needs rolling back.
 */
export async function withReadTransaction<T>(
  fn: (tx: DbTx) => Promise<T>,
  options: ReadTransactionOptions = {},
): Promise<T> {
  const settings = options.settings ?? {};
  const open = currentTx();
  if (open === undefined) {
    return withTransaction(
      async (tx) => {
        await setLocal(tx, settings);
        return fn(tx);
      },
      { readOnly: true, client: options.client },
    );
  }
  assert(
    options.client === undefined || options.client === open.origin,
    'withReadTransaction({ client }) inside a transaction opened on a different client: it joins the open transaction, so nothing would run on the client named here',
    'run the read outside the open transaction — await withReadTransaction(fn, { client }) after it returns — or drop { client } to read inside it',
  );
  const prior = await readLocal(open, Object.keys(settings));
  await setLocal(open, settings);
  let result: T;
  try {
    result = await fn(open);
  } catch (error) {
    // The outer transaction may be aborted by `fn`'s failure; a restore would then fail too, and
    // the caller needs `fn`'s error. The abort discards the local values with everything else.
    await setLocal(open, prior).catch(() => undefined);
    throw error;
  }
  await setLocal(open, prior);
  return result;
}
