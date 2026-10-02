// `x db migrate`'s second look at the database it just migrated: does it hold a trigger, function,
// view, type or sequence that replaying the migrations does not create? `runMigrations` compares
// tables against the snapshot and closes its connection; a snapshot records only what entities
// declare, so everything else is asked here, against the catalog the schema dump was rendered from.

import type { DriftDifference } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { introspectCatalog, unexpectedObjects } from '@ultimat3/db/schema-dump';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The same boot `runMigrations` used, reopened: that function is `serve.ts`'s and is deliberately
 * not wrapped, so the connection it held is gone by the time its report is in hand. Reopening an
 * embedded database is a fraction of a second; `x db migrate` is not a hot path.
 */
export async function liveObjectDrift(
  root: string,
  env: Env,
  expected: CatalogDescription,
): Promise<readonly DriftDifference[]> {
  const queue = await startQueue(resolveServices(root, env), undefined, env);
  try {
    return unexpectedObjects(await introspectCatalog({ client: queue.db }), expected);
  } finally {
    await queue.stop();
  }
}
