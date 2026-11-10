// Single responsibility: the write half of a `defineDriver` repository. A custom store enforces
// no CHECK constraint, so EVERY invariant is judged here on the row as it will be stored, with the
// tenant, before the store is called — and the store is handed only scoped plans and judged rows.

import { refuseAbandoned } from '@ultimat3/db';
import { conflictKeys, upsertPlan } from './bulk-write';
import { entityNow } from './clock';
import { narrowRow } from './columns';
import { checkedDelete } from './driver-delete';
import type { DriverScope } from './driver-scope';
import {
  assertWrittenInScope,
  sameTenantProperties,
  sameTenantReferences,
} from './driver-write-scope';
import { SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { assertedRowsTooMany, MAX_ASSERTED_ROWS } from './invariants';
import { mergedRow } from './memory-update';
import { deletePlan, idPlan, namedColumns, singleKeyOf, updatePlan } from './plan';
import type { Repo, RepoOptions } from './repo';
import { assertRowTenant, type QueryPlan } from './tenancy';
import type { RowPatch, RowWrite } from './types';

export type DriverWrites<Row> = Pick<
  Repo<Row>,
  'insert' | 'insertAll' | 'upsertAll' | 'update' | 'delete' | 'deleteWhere' | 'updateWhere'
>;

export const driverWrites = <Row>(scope: DriverScope<Row>): DriverWrites<Row> => {
  const { entity, raw } = scope;
  const references = sameTenantReferences(entity, scope.rawFor);
  /** What the store handed back, checked against the tenants the write named. */
  const returned = (op: string, written: readonly Row[], rows: readonly Row[]) =>
    assertWrittenInScope(scope.definition.name, entity, op, written, rows);

  /** Narrowed, tenant-checked and judged as one batch, before any of it is stored. */
  const judged = (op: string, given: readonly RowWrite<Row>[]): readonly Row[] => {
    const batch = given.map((row) => narrowRow<Row>(entity.$columns, row));
    for (const row of batch) {
      assertRowTenant(entity.$name, entity.$tenantColumn, op, row);
      entity.$assert(row);
    }
    return batch;
  };

  /**
   * A patch applied to the rows a plan matches. With an invariant declared, every merged row is
   * judged first, bounded as a judged write is on Postgres; then one store call. Answers how many rows the store wrote.
   */
  const patched = async (
    op: string,
    plan: QueryPlan,
    patch: object,
    options: RepoOptions | undefined,
  ): Promise<number> => {
    const tx = scope.txOf(op, options);
    // Nothing to judge: no read-back and no cap — one store call, as Postgres sends one statement.
    // The patch's tenant was judged by the caller; a soft-delete stamp names none.
    const movesReference = namedColumns(patch).some(([key]) =>
      sameTenantProperties(entity).has(key),
    );
    if (entity.$invariants.length === 0 && !movesReference) {
      const narrowed = narrowRow<Record<string, unknown>>(
        entity.$columns,
        Object.fromEntries(namedColumns(patch)),
      );
      return raw.update({ plan, tx }, narrowed);
    }
    // Every invariant, a SQL-expressible one too: a custom store enforces no CHECK.
    const found = scope.checked(
      op,
      plan,
      await raw.select({ plan, after: undefined, limit: MAX_ASSERTED_ROWS + 1, tx }),
    );
    if (found.length > MAX_ASSERTED_ROWS) throw assertedRowsTooMany(entity.$name, op, found.length);
    const [first] = found;
    if (first === undefined) return 0;
    const results = found.map((row) => mergedRow(entity, row, patch));
    for (const merged of results) {
      assertRowTenant(entity.$name, entity.$tenantColumn, op, merged);
      entity.$assert(merged);
    }
    await references(results);
    // The narrowed values the merge produced — the same for every row — so the store holds what
    // was judged rather than a money `bigint` the row type never carries.
    const merged = mergedRow(entity, first, patch) as Record<string, unknown>;
    const values = Object.fromEntries(namedColumns(patch).map(([key]) => [key, merged[key]]));
    return raw.update({ plan, tx }, values);
  };

  /** Hard or soft, decided once so `delete(id)` and `deleteWhere` cannot drift apart. */
  const removed = (op: string, plan: QueryPlan, options: RepoOptions | undefined) =>
    entity.$softDelete
      ? patched(op, plan, { [SOFT_DELETE_COLUMN]: entityNow() }, options)
      : checkedDelete(scope, op, plan, options);

  return {
    async insert(values, options) {
      refuseAbandoned();
      const [row] = judged('insert', [values]);
      if (row === undefined) return narrowRow<Row>(entity.$columns, values);
      await references([row]);
      const stored = await raw.insert([row], { tx: scope.txOf('insert', options) });
      const [written] = returned('insert', [row], stored);
      return written ?? row;
    },

    async insertAll(given, options) {
      refuseAbandoned();
      const batch = judged('insertAll', given);
      if (batch.length === 0) return [];
      await references(batch);
      return returned(
        'insertAll',
        batch,
        await raw.insert(batch, { tx: scope.txOf('insertAll', options) }),
      );
    },

    async upsertAll(given, args) {
      refuseAbandoned();
      scope.need('upsertAll', 'upsert');
      const batch = given.map((row) => narrowRow<Row>(entity.$columns, row));
      const { onConflict, onMatch = 'update', overwrites } = args;
      const plan = upsertPlan(entity, batch, onConflict, onMatch, overwrites);
      conflictKeys(entity, plan, batch);
      judged('upsertAll', batch);
      await references(batch);
      const stored = (await raw.upsert?.(batch, plan, { tx: scope.txOf('upsertAll', args) })) ?? [];
      return returned('upsertAll', batch, stored);
    },

    async update(id, given, options) {
      refuseAbandoned();
      const op = 'update';
      const patch = entity.$parsePatch(given);
      const plan = scope.storePlan(op, idPlan(entity, id, options, op));
      assertRowTenant(entity.$name, entity.$tenantColumn, op, patch);
      if (namedColumns(patch).length > 0 && (await patched(op, plan, patch, options)) === 0) {
        throw notFound(entity.$name, id);
      }
      // The row as the store now holds it — what `returning *` answers on Postgres: read by the
      // key the patch left it under, soft-deleted or not, since the patch may have moved either.
      const tx = scope.txOf(op, options);
      // Only a patch that NAMES the stamp may read a soft-deleted row back: an empty patch wrote
      // nothing, so `update(deletedId, {})` stays the `X_NOT_FOUND` both shipped drivers answer.
      const named = namedColumns(patch);
      const movedTo = named.find(([column]) => column === singleKeyOf(entity, op));
      const key = movedTo === undefined ? id : String(movedTo[1]);
      const stamps = entity.$softDelete && named.some(([column]) => column === SOFT_DELETE_COLUMN);
      const reread = scope.storePlan(op, idPlan(entity, key, options, op), stamps);
      const [after] = scope.checked(
        op,
        reread,
        await raw.select({ plan: reread, after: undefined, limit: 1, tx }),
      );
      if (after === undefined) throw notFound(entity.$name, id);
      return after;
    },

    async delete(id, options) {
      refuseAbandoned();
      const plan = scope.storePlan('delete', idPlan(entity, id, options, 'delete'));
      if ((await removed('delete', plan, options)) === 0) throw notFound(entity.$name, id);
    },

    async deleteWhere(filter, options) {
      refuseAbandoned();
      const op = 'deleteWhere';
      return removed(op, scope.storePlan(op, deletePlan(entity, filter, options, op)), options);
    },

    async updateWhere(filter, given, options) {
      refuseAbandoned();
      const op = 'updateWhere';
      const patch = entity.$parsePatch(given) as RowPatch<Row>;
      const plan = scope.storePlan(op, updatePlan(entity, filter, patch, options, op));
      assertRowTenant(entity.$name, entity.$tenantColumn, op, patch);
      return patched(op, plan, patch, options);
    },
  };
};
