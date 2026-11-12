// `x db migrate`'s second look at the database it just migrated: a trigger, function, view, type or
// sequence replaying the migrations does not create, and a framework table's storage parameters
// moved by hand. A snapshot records only what entities declare, so both are asked here, against the
// catalog the schema dump was rendered from; `runMigrations` has closed its connection by then.

import type { DbClient, DriftDifference, TableStorageDifference } from '@ultimat3/db';
import { readTableStorageDrift } from '@ultimat3/db';
import type { CatalogDescription } from '@ultimat3/db/schema-dump';
import { introspectCatalog, unexpectedObjects } from '@ultimat3/db/schema-dump';
import { frameworkTableStorage } from './framework-schema';
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
    const [catalog, storage] = await Promise.all([
      introspectCatalog({ client: queue.db }),
      frameworkStorageDrift(queue.db),
    ]);
    return [...unexpectedObjects(catalog, expected), ...storage];
  } finally {
    await queue.stop();
  }
}

/** One storage difference as drift: a missing table is `missing-table`, anything else its own kind. */
export function storageDifference(difference: TableStorageDifference): DriftDifference {
  const { table, parameter, declared, live, fix } = difference;
  return {
    kind: parameter === 'table' ? 'missing-table' : 'changed-table-storage',
    table,
    column: null,
    cause:
      parameter === 'table'
        ? `framework table "${table}" is absent; the framework schema apply creates it`
        : `framework table "${table}" has ${parameter} ${live}; its tableStorage() declares ${declared}`,
    fix,
  };
}

/**
 * Every `tableStorage()` a `FRAMEWORK_SCHEMA` row declares, against `pg_class` in one read. A hand
 * `alter table x_rate_limit set logged` is reported here with the `alter` that undoes it; the next
 * framework apply would also converge it, but only on the next build.
 */
export async function frameworkStorageDrift(client: DbClient): Promise<readonly DriftDifference[]> {
  return (await readTableStorageDrift(client, frameworkTableStorage())).map(storageDifference);
}
