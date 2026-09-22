// Table → record type, over the registered entities. A changefeed and a snapshot name the
// physical relation; the client store keys records by entity name, and this is the one bridge —
// memoised against the registry's generation, so a per-change lookup is one `Map` read.

import { invariantViolated } from './entity-error';
import type { RecordProjection } from './record-projection';
import type { RegistryEntry } from './registry';
import { registeredEntities, registryGeneration } from './registry';

let cached: {
  readonly generation: number;
  readonly byTable: ReadonlyMap<string, RegistryEntry>;
} | null = null;

const tableIndex = (): ReadonlyMap<string, RegistryEntry> => {
  const generation = registryGeneration();
  if (cached !== null && cached.generation === generation) return cached.byTable;
  const byTable = new Map<string, RegistryEntry>();
  for (const entry of registeredEntities()) {
    const other = byTable.get(entry.tableName);
    // Two entities over one relation (`table:` lets an app adopt a table twice) leave a changed
    // row with no single record type; refused rather than guessed, since the wrong guess writes
    // one entity's row into another's records.
    if (other !== undefined) {
      throw invariantViolated(
        entry.name,
        'table',
        `shares table "${entry.tableName}" with entity "${other.name}", so a change on it has no one record type — give one of them its own table, or stop streaming it`,
      );
    }
    byTable.set(entry.tableName, entry);
  }
  cached = { generation, byTable };
  return byTable;
};

/** The record type (entity name) a table's rows belong to, or `undefined` for an unknown table. */
export const recordTypeForTable = (table: string): string | undefined =>
  tableIndex().get(table)?.name;

/**
 * The whole client projection a table's rows belong to — type, key, row schema, `persist` — or
 * `undefined` for an unknown table. Same index as `recordTypeForTable`, so the two never disagree.
 */
export const recordProjectionForTable = (table: string): RecordProjection | undefined =>
  tableIndex().get(table)?.projection;
