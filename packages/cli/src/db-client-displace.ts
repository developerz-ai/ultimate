// A CLI command that opens the app's database for one run (`startDb`) and owes the process its
// `db()` back: an installed client as it was, a lazily built default it dropped closed — never
// orphaned — and both of its own pools closed whatever the run did.

import { logger, renderThrowable } from '@ultimat3/core';
import { ambientClient, type DbClient, dbClientInstalled, setDbClient } from '@ultimat3/db';

const closable = (client: DbClient): client is DbClient & { close(): Promise<void> } =>
  'close' in client && typeof client.close === 'function';

/**
 * Read BEFORE the command installs anything; call what it returns once it is done. `db()` is put
 * back synchronously on the call, so a caller may settle the returned close beside its own.
 */
export function displaceAmbient(): () => Promise<void> {
  const installed = dbClientInstalled();
  const previous = ambientClient();
  return async () => {
    if (installed) {
      setDbClient(previous);
      return;
    }
    setDbClient(undefined);
    if (previous !== undefined && closable(previous)) await previous.close();
  };
}

interface Closable {
  close(): Promise<void>;
}

/**
 * Open, run, then put `db()` back and close every pool whatever happened. The open is inside the
 * guarded scope (`startDb` installs before it returns); one rejected close never skips another.
 * The run's own failure is what is thrown, a close failure beside it is logged; after a good run a
 * close failure is thrown.
 */
export async function withOpenedDb<T>(
  open: () => { readonly client: DbClient & Closable; readonly replica?: Closable | undefined },
  run: (client: DbClient) => Promise<T>,
): Promise<T> {
  const restore = displaceAmbient();
  let opened: ReturnType<typeof open> | undefined;
  let outcome: { readonly value: T } | { readonly error: unknown };
  try {
    opened = open();
    outcome = { value: await run(opened.client) };
  } catch (error) {
    outcome = { error };
  }
  const closed = await Promise.allSettled([
    restore(),
    opened?.client.close(),
    opened?.replica?.close(),
  ]);
  const rejected = closed.flatMap((one) => (one.status === 'rejected' ? [one.reason] : []));
  if ('error' in outcome) {
    for (const reason of rejected) {
      logger.warn('x db could not close its database', { cause: renderThrowable(reason) });
    }
    throw outcome.error;
  }
  if (rejected.length > 0) throw rejected[0];
  return outcome.value;
}
