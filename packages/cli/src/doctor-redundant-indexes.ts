// `x doctor`'s redundant-index listing: each implicit index the entities describe that another
// index already leads with, still in the newest migration's snapshot — and the one command that
// drops them. A LISTING, never a finding: dropping is a reviewed migration the app opts into.

import type { SchemaDescription } from '@ultimat3/db';
import { declaredSchema } from '@ultimat3/db';
import type { RegistryEntry } from '@ultimat3/entity';
import { registeredEntities } from '@ultimat3/entity';
import { loadApp } from './app-load';
import { msg } from './messages';
import { readMigrations } from './migrations';
import type { CommandResult, JsonValue } from './output';
import { pendingRedundant, type RedundantIndex, redundantIndexes } from './redundant-indexes';

/** The command the listing hands out — the flag `cmd-db-spec.ts` declares. */
export const DROP_REDUNDANT_FIX = 'x db gen "drop redundant indexes" --drop-redundant';

export interface RedundantSource {
  readonly entries: readonly RegistryEntry[];
  readonly current: SchemaDescription;
}

/** The registry and the newest snapshot, or `undefined` when either is not there to read. */
export type ReadRedundantSource = (root: string) => Promise<RedundantSource | undefined>;

/** `appEntities`' rule (`schema-drift.ts`): a registry short one module is not "none covered". */
const appSource: ReadRedundantSource = async (root) => {
  const app = await loadApp(root);
  if (app.findings.length > 0) return undefined;
  const current = declaredSchema(await readMigrations(root));
  return current === undefined ? undefined : { entries: registeredEntities(), current };
};

/** The I/O half. `undefined` when the app would not load or has no snapshot to compare. */
export async function redundantIndexesProbe(
  root: string,
  read: ReadRedundantSource = appSource,
): Promise<readonly RedundantIndex[] | undefined> {
  const source = await read(root);
  if (source === undefined) return undefined;
  return pendingRedundant(redundantIndexes(source.entries), source.current);
}

/** The listing, on a result `x doctor` already decided: `ok` and the findings stay as they came. */
export function withRedundantIndexes(
  result: CommandResult,
  redundant: readonly RedundantIndex[] | undefined,
): CommandResult {
  if (redundant === undefined) return result;
  const data = typeof result.data === 'object' && result.data !== null ? result.data : {};
  const listed: JsonValue = redundant.map(({ table, name, columns, coveredBy }) => ({
    table,
    name,
    columns: [...columns],
    coveredBy,
  }));
  return {
    ...result,
    data: { ...(data as Record<string, JsonValue>), redundantIndexes: listed },
    ...(redundant.length === 0
      ? {}
      : {
          lines: [
            ...(result.lines ?? []),
            msg('cli.doctor.redundantIndexes', {
              count: redundant.length,
              fix: DROP_REDUNDANT_FIX,
            }),
            ...redundant.map(
              ({ table, name, columns, coveredBy }) =>
                `  ${table}.${name} (${columns.join(', ')}) — ${coveredBy}`,
            ),
          ],
        }),
  };
}
