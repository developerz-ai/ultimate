// Single responsibility: the write half of a `defineDriver` repository. A custom store enforces
// no CHECK constraint, so EVERY invariant is judged here on the row as it will be stored, with the
// tenant, before the store is called — and the store is handed only scoped plans and judged rows.

import { refuseAbandoned } from '@ultimat3/db';
import { keyOf } from './batch-read';
import { conflictKeys, upsertPlan } from './bulk-write';
import { entityNow } from './clock';
import { narrowRow } from './columns';
import { copyColumns } from './copy-plan';
import { kindOf, valueAt } from './cursor';
import { byKeys, checkedDelete } from './driver-delete';
import type { DriverScope } from './driver-scope';
import {
  assertWrittenInScope,
  sameTenantProperties,
  sameTenantReferences,
} from './driver-write-scope';
import { type EntityCore, SOFT_DELETE_COLUMN } from './entity';
import { notFound } from './errors';
import { assertedRowsTooMany, MAX_ASSERTED_ROWS } from './invariants';
import { mergedRow } from './memory-update';
import { idPlan, namedColumns, singleKeyOf } from './plan';
import type { Repo, RepoOptions, Tx } from './repo';
import { rowKey } from './row-key';
import { advancingVersionColumn, deletionStamp, VERSION_STEP_MS } from './search-index-version';
import { writtenRowsSink } from './search-written-rows';
import { assertRowTenant, type QueryPlan } from './tenancy';
import type { RowPatch, RowWrite } from './types';
import { judgeUpdateMany, updateManyPlan } from './update-many';
import { assertVersionedUpdate, versionOf } from './version-lock';
import { entityStale } from './version-lock-errors';
import { updateWherePlan, writeWherePlan } from './write-where';

export type DriverWrites<Row> = Pick<
  Repo<Row>,
  | 'insert'
  | 'insertAll'
  | 'upsertAll'
  | 'update'
  | 'delete'
  | 'deleteWhere'
  | 'updateWhere'
  | 'insertAllCount'
  | 'upsertAllCount'
  | 'copyAll'
  | 'updateMany'
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
   * The rows a write left, read back by their keys alone — a patch may move a row out of the
   * filter that matched it — for the search mirror, which asked (`writtenRowsSink`).
   */
  const writtenBack = async (
    op: string,
    plan: QueryPlan,
    rows: readonly Row[],
    tx: Tx | undefined,
  ) => {
    const keyed = byKeys(scope, { ...plan, where: [] }, rows);
    const read: Row[] = [];
    for (const each of keyed) {
      const found = await raw.select({ plan: each, after: undefined, limit: rows.length, tx });
      read.push(...scope.checked(op, each, found));
    }
    return read;
  };

  /**
   * A patch applied to the rows a plan matches. With an invariant declared, every merged row is
   * judged first, bounded as a judged write is on Postgres; then one store call. Answers how many
   * rows the store wrote. A searchable entity's version is the STORE's to advance, per row and
   * atomically (`DriverRepo.update`'s `advance`): a value the kit computed from a read would let a
   * second process's newer version be written over.
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
    const sink = writtenRowsSink();
    const version = advancingVersionColumn(entity as EntityCore<unknown>);
    const advance =
      version !== undefined && namedColumns(patch).some(([key]) => key === version)
        ? { property: version, stepMs: VERSION_STEP_MS }
        : undefined;
    const narrowed = narrowRow<Record<string, unknown>>(
      entity.$columns,
      Object.fromEntries(namedColumns(patch)),
    );
    // A declared version lock is per row (`v = stored + 1`), which one store patch cannot say: the
    // judged path below, one compare-and-set write per row.
    const lock = versionOf(entity);
    if (entity.$invariants.length === 0 && !movesReference && lock === null) {
      // The search mirror asked for the rows: read them first, as the judged path does. Past the
      // judged bound they are not handed over — the mirror logs the write it could not name.
      const before =
        sink === undefined
          ? []
          : scope.checked(
              op,
              plan,
              await raw.select({ plan, after: undefined, limit: MAX_ASSERTED_ROWS + 1, tx }),
            );
      const written = await raw.update({ plan, tx }, narrowed, advance);
      if (sink !== undefined && before.length <= MAX_ASSERTED_ROWS) {
        sink(await writtenBack(op, plan, before, tx));
      }
      return written;
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
    // was judged rather than a money `bigint` the row type never carries. The version is the
    // patch's instant: the store advances it per row.
    if (lock !== null) {
      let written = 0;
      for (const [at, row] of found.entries()) {
        const result = results[at] as Readonly<Record<string, unknown>>;
        const values = Object.fromEntries(namedColumns(patch).map(([key]) => [key, result[key]]));
        values[lock] = result[lock];
        if (advance !== undefined) values[advance.property] = narrowed[advance.property];
        // Conditioned on the version the row was READ at: a writer in between matches nothing.
        const keyed = {
          ...plan,
          where: [
            ...plan.where,
            ...entity.$primaryKey.map((key) => ({
              column: key,
              op: 'eq' as const,
              value: valueAt(row, key),
            })),
            { column: lock, op: 'eq' as const, value: valueAt(row, lock) },
          ],
        };
        const count = await raw.update({ plan: keyed, tx }, values, advance);
        if (count === 0) {
          throw entityStale(entity.$name, lock, rowKey(entity, row), valueAt(row, lock), undefined);
        }
        written += count;
      }
      if (sink !== undefined) sink(await writtenBack(op, plan, found, tx));
      return written;
    }
    const merged = mergedRow(entity, first, patch) as Record<string, unknown>;
    const values = Object.fromEntries(namedColumns(patch).map(([key]) => [key, merged[key]]));
    if (advance !== undefined) values[advance.property] = narrowed[advance.property];
    const written = await raw.update({ plan, tx }, values, advance);
    if (sink !== undefined) sink(await writtenBack(op, plan, found, tx));
    return written;
  };

  /** Hard or soft, decided once so `delete(id)` and `deleteWhere` cannot drift apart. */
  const removed = (op: string, plan: QueryPlan, options: RepoOptions | undefined) =>
    entity.$softDelete
      ? patched(
          op,
          plan,
          deletionStamp(entity as EntityCore<unknown>, SOFT_DELETE_COLUMN, entityNow()),
          options,
        )
      : checkedDelete(scope, op, plan, options);

  const writes: DriverWrites<Row> = {
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
      assertVersionedUpdate(entity, patch);
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
      return removed(op, scope.storePlan(op, writeWherePlan(entity, filter, options, op)), options);
    },

    async updateWhere(filter, given, options) {
      refuseAbandoned();
      const op = 'updateWhere';
      const patch = entity.$parsePatch(given) as RowPatch<Row>;
      const plan = scope.storePlan(op, updateWherePlan(entity, filter, patch, options, op));
      assertRowTenant(entity.$name, entity.$tenantColumn, op, patch);
      return patched(op, plan, patch, options);
    },

    // A store answers rows from every insert, so the count is their length: one judging path.
    insertAllCount: async (given, options) => (await writes.insertAll(given, options)).length,
    upsertAllCount: async (given, args) => (await writes.upsertAll(given, args)).length,
    copyAll: async (given, options) => {
      copyColumns(entity, given as readonly RowPatch<Row>[]);
      return (await writes.insertAll(given, options)).length;
    },

    /**
     * Judged as ONE batch first — tenant, invariants, keys, same-tenant references, the shape
     * `memoryRepo` judges — then one `patched` write per row, since a store's `update` sets one
     * patch on every row it matches. That is n store calls, so a refusal part way (a unique the
     * store judges against a row outside the batch) writes the rows already moved BACK before it
     * rethrows: all or nothing, as `updateWhere`'s single call is. Missing, soft-deleted and other
     * tenants' ids are not counted.
     */
    async updateMany(given, options) {
      refuseAbandoned();
      const op = 'updateMany';
      const plan = updateManyPlan(entity, given, options);
      if (plan.patches.length === 0) return 0;
      const tx = scope.txOf(op, options);
      const match = scope.storePlan(op, plan.match);
      const found = scope.checked(
        op,
        match,
        await raw.select({ plan: match, after: undefined, limit: plan.patches.length, tx }),
      );
      const merged = judgeUpdateMany(entity, plan, found, [], (row) => rowKey(entity, row));
      await references(merged);
      const kind = kindOf(entity, plan.key) ?? '';
      const cell = (row: unknown) => keyOf(kind, valueAt(row, plan.key));
      const before = new Map(found.map((row) => [cell(row), row]));
      const after = new Map(merged.map((row, at) => [cell(found[at]), row]));
      const moved: (readonly [Row, Row])[] = [];
      let written = 0;
      try {
        for (const { id, patch } of plan.patches) {
          const stored = before.get(keyOf(kind, id));
          const result = after.get(keyOf(kind, id));
          if (stored === undefined || result === undefined) continue;
          const one = scope.storePlan(op, idPlan(entity, id, options, op));
          const count = await patched(op, one, patch, options);
          if (count > 0) moved.push([stored, result]);
          written += count;
        }
      } catch (error) {
        for (const [stored, result] of moved.reverse()) {
          const where = idPlan(entity, String(valueAt(result, plan.key)), options, op);
          const values = Object.fromEntries(
            [...plan.properties, plan.key].map((property) => [property, valueAt(stored, property)]),
          );
          await raw.update({ plan: scope.storePlan(op, where, true), tx }, values);
        }
        throw error;
      }
      return written;
    },
  };
  return writes;
};
