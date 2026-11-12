// The SQL subject both Postgres runs share (PGlite in `unit`, a server in `live`): each check's
// tables dropped and re-created from the entities' own migration — the DDL `x db gen` writes,
// never a hand-written table — then `postgresDriver()` over the installed client.

import type { DbClient } from '@ultimat3/db';
import { generateMigration, raw, statementsOf } from '@ultimat3/db';
import type { EntityCore } from '@ultimat3/entity';
import { postgresDriver } from '@ultimat3/entity';
import { DRIVER_CAPABILITIES } from '@ultimat3/entity/adapter';
import type { EntityDriverSubject } from './entity-driver-conformance';

const MIGRATED_AT = new Date('2026-11-09T00:00:00.000Z');

export const recreateTables = async (
  client: DbClient,
  entities: readonly EntityCore[],
): Promise<void> => {
  for (const one of entities) {
    await client.execute(raw(`drop table if exists "${one.$table}" cascade`));
  }
  const migration = generateMigration({
    entities: entities.map((one) => one.$describe()),
    name: 'entity conformance',
    now: MIGRATED_AT,
  });
  for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));
};

/** `setDbClient(client)` first: seeds, locks and transactions resolve the ambient client. */
/** Backends of this database blocked on a lock, this one aside: the pool's contenders. */
export const pgLockWaiters = (client: () => DbClient) => async (): Promise<number> =>
  (
    await client().one<{ n: number }>(
      raw(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()",
      ),
    )
  )?.n ?? 0;

export const sqlSubject = (
  client: () => DbClient,
  options: { readonly lockWaiters?: () => Promise<number> } = {},
): EntityDriverSubject => ({
  open: async (entities) => {
    await recreateTables(client(), entities);
    return postgresDriver();
  },
  capabilities: DRIVER_CAPABILITIES,
  foreignKeys: true,
  history: true,
  counters: true,
  ...(options.lockWaiters === undefined ? {} : { lockWaiters: options.lockWaiters }),
});
