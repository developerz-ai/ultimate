// Single responsibility: `entity({ history: true })`'s history table as a REAL entity, registered
// beside its parent — so `$tenantColumn` holds, row security emits its policy, the tenant proof and
// subject data walk it, and a read of it is an ordinary tenant-scoped, cursor-paged read.

import { t } from '@ultimat3/schema';
import { columnName, makeColumn } from './column';
import { text, timestamp, uuid } from './columns';
import { json } from './columns-data';
import type { Entity } from './entity';
import { entity } from './entity';
import { invariantViolated } from './errors';
import type { AnyColumn, ColumnMap, RowOf } from './types';

/** `history: true`, or with a retention window of its own. No default window, here or anywhere. */
export type HistoryInit = true | { readonly retain?: { readonly after: string } };

/** The parent facts the history table is built from. */
export interface HistoryParent {
  readonly name: string;
  readonly table: string;
  readonly columns: ColumnMap;
  readonly primaryKey: readonly string[];
  readonly tenantColumn: string | null;
}

/** A row image: the stored row as `to_jsonb` spells it, physical names. Any JSON object. */
const image = () => json(t.record(t.json())).nullable();

/** Every history table's own columns; the parent's tenant column joins them at runtime. */
const historyColumns = () => ({
  id: uuid().primaryKey(),
  rowId: text(),
  op: text(),
  at: timestamp().defaultNow(),
  actorId: text().nullable(),
  requestId: text().nullable(),
  before: image(),
  after: image(),
});

export type HistoryColumns = ReturnType<typeof historyColumns>;
/**
 * A history entity as a read types it. The tenant column is on the row at runtime and absent from
 * the type: every read of it is scoped by the repository, never filtered by hand.
 */
export type HistoryEntity = Entity<RowOf<HistoryColumns>, HistoryColumns>;

/**
 * The tenant column, copied without its foreign key: a history row outlives an org's cascade only
 * until its purge, and a key would cascade a delete the guard refuses.
 */
const tenantCopy = (column: AnyColumn): AnyColumn => {
  const { references: _r, onDelete: _o, crossTenant: _c, countedIn: _n, ...meta } = column.$meta;
  return makeColumn({ ...meta, tenant: true, index: true }, column.$parse, false);
};

/** The history entity of `parent`, declared now. Its name and table are the parent's `_history`. */
export function historyEntity(parent: HistoryParent, init: HistoryInit): HistoryEntity {
  if (parent.primaryKey.length !== 1) {
    throw invariantViolated(
      parent.name,
      'history',
      'history records a row by its single primary key, and this entity declares a composite one',
    );
  }
  const tenant = parent.tenantColumn;
  const tenantColumn = tenant === null ? undefined : parent.columns[tenant];
  const columns = {
    ...historyColumns(),
    ...(tenant === null || tenantColumn === undefined
      ? {}
      : { [tenant]: tenantCopy(tenantColumn).column(columnName(tenant, tenantColumn.$meta)) }),
  };
  const after = init === true ? undefined : init.retain?.after;
  // Typed as its fixed columns: the tenant key is a runtime name, so it cannot be in the type.
  return entity<ColumnMap>(`${parent.name}_history`, {
    table: `${parent.table}_history`,
    columns,
    historyOf: parent.name,
    indexes: [
      { on: [...(tenant === null ? [] : [tenant]), 'rowId', 'at'] },
      ...(after === undefined ? [] : [{ on: ['at'] }]),
    ],
    ...(after === undefined ? {} : { retain: { after, on: 'at' } }),
  }) as unknown as HistoryEntity;
}
