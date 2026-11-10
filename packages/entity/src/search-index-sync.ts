// The search index WRITE path: what a committed write of a searchable entity sends to an installed
// external index. A live row is indexed (`committed`: it replaces a tombstone); a deleted one — hard,
// or soft-stamped — removed at a tombstone no older than its last version. Ops are taken when the
// write runs and sent at COMMIT (`search-mirror-batch.ts`), so a rollback indexes nothing.

import { entityNow } from './clock';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import type { RepoOptions } from './repo';
import { rowKey } from './row-key';
import { searchDocumentOf } from './search-index';
import { searchIndex } from './search-index-installed';
import { answersInStatement } from './search-index-postgres';
import { searchVersionOf, VERSION_STEP_MS } from './search-index-version';
import { mirrorBatch, mirrorFailed } from './search-mirror-batch';
import { commitScope } from './write-commit';

export { SEARCH_INDEX_WRITE_FAILED } from './search-mirror-batch';

type Record_ = Readonly<Record<string, unknown>>;

/** One write's mirror: bound to the index installed and the transaction open when the write ran. */
export interface SearchMirror {
  /** Rows the write left in place: indexed, or removed when a soft-delete stamp is on them. */
  changed(op: string, rows: readonly unknown[]): void;
  /** Rows the write deleted. */
  deleted(op: string, rows: readonly unknown[]): void;
  /** The write touched `count` rows its driver did not name: said out loud, never silent. */
  unnamed(op: string, count: number): void;
}

const isRecord = (row: unknown): row is Record_ => typeof row === 'object' && row !== null;

const tenantOf = (core: EntityCore<unknown>, row: Record_): string | null => {
  const column = core.$tenantColumn;
  const tenant = column === null ? null : row[column];
  return typeof tenant === 'string' ? tenant : null;
};

const keyOf = (entity: string, tenant: string | null, id: string): string =>
  JSON.stringify([entity, tenant, id]);

export const mirrorFor = (
  core: EntityCore<unknown>,
  options: RepoOptions | undefined,
): SearchMirror | undefined => {
  if (core.$search === null) return undefined;
  const index = searchIndex();
  if (answersInStatement(index)) return undefined;
  const entity = core.$name;
  const batch = mirrorBatch(index, commitScope(options));
  // Read when the write runs, not at commit: a hard delete's tombstone is no older than its instant.
  const deletedAt = entityNow().getTime();
  /** The tombstone a row's removal leaves: past every version the row was indexed at. */
  const removal = (op: string, row: Record_, at: number) => {
    const tenant = tenantOf(core, row);
    const id = rowKey(core, row);
    const version = Math.max(at, searchVersionOf(core, row) + VERSION_STEP_MS);
    batch.put(keyOf(entity, tenant, id), { op, entity, tenant, id, version });
  };
  const guarded = (op: string, work: () => void) => {
    try {
      work();
    } catch (error) {
      mirrorFailed(entity, op, error);
    }
    batch.done();
  };
  return {
    changed: (op, rows) =>
      guarded(op, () => {
        for (const row of rows.filter(isRecord)) {
          const stamp = core.$softDelete ? row[SOFT_DELETE_COLUMN] : null;
          if (stamp instanceof Date) {
            removal(op, row, stamp.getTime());
            continue;
          }
          const document = searchDocumentOf(core, row);
          batch.put(keyOf(entity, document.tenant, document.id), { op, document });
        }
      }),
    deleted: (op, rows) =>
      guarded(op, () => {
        for (const row of rows.filter(isRecord)) removal(op, row, deletedAt);
      }),
    unnamed: (op, count) => guarded(op, () => batch.unnamed(entity, op, count)),
  };
};

/**
 * Whether a write of `entity` owes the index anything: nothing for an entity with nothing
 * searchable (one property read), nor under the built-in Postgres index, whose vector is the row.
 * Asked per write, so a test's install over the boot's mirrors to the newest one only.
 */
export const mirrors = (entity: EntityCore<unknown>): boolean =>
  entity.$search !== null && !answersInStatement(searchIndex());
