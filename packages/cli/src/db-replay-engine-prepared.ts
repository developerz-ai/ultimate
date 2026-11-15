// A scratch database that starts PREPARED (framework tables and migrations applied) without paying
// for the preparation twice: on the embedded engine a data-directory snapshot keyed by what
// produced it (`@ultimat3/db`'s `dataSnapshot`), on Postgres a template database of that key cloned
// with `CREATE DATABASE … TEMPLATE`. The key IS the invalidation: a new migration is a new key.

// why: Bun ships no path joiner.
import { join } from 'node:path';
import type { DbClient } from '@ultimat3/db';
import { pgliteClient } from '@ultimat3/db';
import type { ReplayEngine } from './db-replay-engine';
import { withScratchDatabase } from './db-replay-engine';
import type { ScratchPreparation } from './db-replay-engine-template';
import { PREPARED_KEEP, withPreparedPostgres } from './db-replay-engine-template';

export type { ScratchPreparation } from './db-replay-engine-template';
export { PREPARED_KEEP, templateNameFor } from './db-replay-engine-template';

/** Where the embedded snapshots live: a directory of their own, under the app's state dir. */
export const preparedSnapshotDir = (stateDir: string): string => join(stateDir, 'cache', 'scratch');

async function withPreparedPglite<T>(
  engine: Extract<ReplayEngine, { kind: 'embedded' }>,
  stateDir: string,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = pgliteClient({
    extensions: engine.extensions,
    snapshotDir: join(stateDir, 'cache'),
    dataSnapshot: {
      dir: preparedSnapshotDir(stateDir),
      key: preparation.key,
      keep: PREPARED_KEEP,
    },
  });
  try {
    if (!(await client.restoredDataSnapshot?.())) {
      await preparation.prepare(client);
      // After the preparation and before any row of the caller's: what is kept is the schema.
      await client.saveDataSnapshot?.();
    }
    return await work(client);
  } finally {
    await client.close();
  }
}

/**
 * `work` on a scratch database `preparation` has been applied to — restored or cloned when its key
 * was prepared before, prepared (and kept) when not. No `stateDir`, embedded: prepared every time.
 */
export async function withPreparedScratch<T>(
  engine: ReplayEngine,
  stateDir: string | undefined,
  preparation: ScratchPreparation,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  if (engine.kind === 'postgres') return withPreparedPostgres(engine.adminUrl, preparation, work);
  if (stateDir === undefined) {
    return withScratchDatabase(engine, stateDir, async (client) => {
      await preparation.prepare(client);
      return work(client);
    });
  }
  return withPreparedPglite(engine, stateDir, preparation, work);
}
