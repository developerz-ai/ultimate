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
export const sqlSubject = (client: () => DbClient): EntityDriverSubject => ({
  open: async (entities) => {
    await recreateTables(client(), entities);
    return postgresDriver();
  },
  capabilities: DRIVER_CAPABILITIES,
  foreignKeys: true,
  history: true,
});
