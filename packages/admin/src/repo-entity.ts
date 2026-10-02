// The ONE adapter from an entity's typed handle — `database()`'s `db.<entity>` — to `AdminRepo`.
// Verbs, the keyset bound and filters are translated here and nowhere else; tenancy, soft delete,
// sealing and invariants stay the handle's, so this file adds no predicate of its own.

import { isUltimateError } from '@ultimat3/core';
import { getEntity, invariantViolated } from '@ultimat3/entity';
import { adminColumnsOf } from './entity-columns';
import type {
  AdminDb,
  AdminEntity,
  AdminFilter,
  AdminListQuery,
  AdminRepo,
  AdminRow,
  AdminTable,
  AdminTableRead,
} from './registry';

type TableOperator = Parameters<AdminTableRead['andWhere']>[1];

/**
 * `contains` is the admin's word for it; `like` with both wildcards is what a driver runs. A Map,
 * so an operator that is not one of the seven answers `undefined` rather than a prototype member.
 */
const OPERATOR_OF: ReadonlyMap<AdminFilter['op'], TableOperator> = new Map([
  ['eq', 'eq'],
  ['neq', 'neq'],
  ['contains', 'like'],
  ['gt', 'gt'],
  ['gte', 'gte'],
  ['lt', 'lt'],
  ['lte', 'lte'],
  ['in', 'in'],
  ['is-null', 'is-null'],
]);

/** `%` and `_` are wildcards to `LIKE`; a `contains` matches the text an operator typed. */
const literal = (text: string): string => text.replace(/[\\%_]/g, (wild) => `\\${wild}`);

/**
 * A comparison value, in the shape the column holds. An instant travels as ISO text — in a URL, in
 * a cursor — and the handle is given the `Date`: Postgres would cast the text, the memory driver
 * compares a `Date` to a string by its characters, and a keyset over `createdAt` (the admin's
 * default sort) then answers page one for every page.
 */
type Typed = (field: string, value: unknown) => unknown;

const typedBy = (entity: AdminEntity): Typed => {
  const instants = new Set(
    adminColumnsOf(entity)
      .filter((column) => column.kind === 'timestamptz')
      .map((column) => column.name),
  );
  return (field, value) => {
    if (typeof value !== 'string' || !instants.has(field)) return value;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? value : at;
  };
};

const predicate =
  (typed: Typed) =>
  (read: AdminTableRead, filter: AdminFilter): AdminTableRead => {
    if (filter.op === 'contains') {
      return read.andWhere(filter.field, 'like', `%${literal(String(filter.value))}%`);
    }
    // One admin operator, two of the handle's: `false` asks for the rows that HAVE a value.
    if (filter.op === 'is-null') {
      return read.andWhere(filter.field, filter.value === false ? 'is-not-null' : 'is-null');
    }
    return read.andWhere(
      filter.field,
      OPERATOR_OF.get(filter.op) ?? 'eq',
      typed(filter.field, filter.value),
    );
  };

const filtered = (
  read: AdminTableRead,
  where: readonly AdminFilter[],
  typed: Typed,
): AdminTableRead => where.reduce(predicate(typed), read);

/**
 * `after`+asc and `before`+desc walk forward; the other two walk back. Written as one XOR rather
 * than a four-branch table, because the four branches are the same fact said twice.
 *
 * `gte`/`lte`, not `gt`/`lt`: rows sharing the boundary's sort value are still on the far side of
 * it, and `dropThroughTie` below is what removes the ones already served.
 */
const sought = (read: AdminTableRead, query: AdminListQuery, typed: Typed): AdminTableRead => {
  const bound = query.after ?? query.before;
  if (bound === undefined) return read;
  const forward = (query.after !== undefined) !== (query.sort.direction === 'desc');
  // The bound is the STRING the cursor carried (`pagination.ts` writes a Date as ISO).
  return read.andWhere(bound.field, forward ? 'gte' : 'lte', typed(bound.field, bound.value));
};

/**
 * Drop everything up to and including the cursor row. A typed chain cannot express the row-value
 * comparison `(sort, id) > (value, id)` a keyset needs, and the alternative — a strict `gt` on the
 * sort column alone — silently skips every row that ties with the boundary.
 */
const dropThroughTie = (
  rows: readonly AdminRow[],
  query: AdminListQuery,
  idField: string,
): readonly AdminRow[] => {
  const bound = query.after ?? query.before;
  if (bound === undefined) return rows;
  const at = rows.findIndex((row) => String(row[idField]) === bound.id);
  return at === -1 ? rows : rows.slice(at + 1);
};

/**
 * One entity + its table → one `AdminRepo`.
 *
 * A row is never spread and never re-parsed here. The handle parses an insert against the entity
 * and asserts every invariant over the stored row merged under a patch, so a second parse would be
 * a second opinion — and a row's sealed properties are non-enumerable, so a spread would drop the
 * very values a whole-row write then needs.
 */
export function adminRepoFor(entity: AdminEntity, table: AdminTable): AdminRepo<AdminRow> {
  const idField = entity.$primaryKey[0] ?? 'id';
  const idColumn = Object.hasOwn(entity.$columns, idField) ? entity.$columns[idField] : undefined;
  const typed = typedBy(entity);
  /**
   * `AdminRepo` carries `id: string` — a URL param, untyped by nature. The primary key column's
   * OWN `$parse` is what earns the crossing: `/posts/nope` is judged here, at the door, instead
   * of reaching the driver as a comparison Postgres answers with a cast error.
   */
  const idOf = (id: string): string => {
    const parsed = idColumn?.$parse === undefined ? id : idColumn.$parse(id);
    if (typeof parsed !== 'string') {
      throw invariantViolated(entity.$name, idField, `expected a string id, got ${typeof parsed}`);
    }
    return parsed;
  };
  /**
   * The same crossing for a READ, where an id that is not one is simply a row that does not exist:
   * `/posts/nope` is the admin's 404, not `X_INVARIANT_VIOLATED` — the operator mistyped a URL and
   * violated nothing. A write keeps the throw: it is reached only after a read found the row.
   */
  const readableId = (id: string): string | undefined => {
    try {
      return idOf(id);
    } catch (error) {
      if (isUltimateError(error) && error.code === 'X_INVARIANT_VIOLATED') return undefined;
      throw error;
    }
  };

  return {
    async list(query: AdminListQuery): Promise<readonly AdminRow[]> {
      const rows = await sought(filtered(table, query.where ?? [], typed), query, typed)
        .orderBy(query.sort.field, query.sort.direction)
        // The tie-break, always: a page boundary on a partial order repeats or drops a row.
        .orderBy(idField, query.sort.direction)
        // One over the requested page so the tie-drop cannot hand back a short page.
        .limit(query.limit + 1)
        .all();
      return dropThroughTie(rows, query, idField).slice(0, query.limit);
    },
    // `async`, so a refused id arrives as a rejection: these return promises, and a caller that
    // chains `.catch()` instead of `await`ing would never see a synchronous throw.
    find: async (id) => {
      const key = readableId(id);
      return key === undefined ? null : table.where({ [idField]: key }).one();
    },
    create: async (input) => table.insert(input),
    update: async (id, patch) => table.update(idOf(id), patch),
    destroy: async (id) => table.delete(idOf(id)),
    count: async (where) => filtered(table, where ?? [], typed).count(),
  };
}

/**
 * The handle's tables, by the ENTITY they serve. `database({ posts })` keys a table by the app's
 * own spelling, which need not be the entity's `$name` — so the name is read off the table's own
 * plan rather than off the key it happens to sit under.
 */
export function adminTablesOf(db: AdminDb): ReadonlyMap<string, AdminTable> {
  return new Map(Object.values(db).map((table) => [table.plan().entity, table]));
}

/**
 * Every entity the handle serves that the admin can address — what an app passes as `entities`
 * when its admin is "all of my tables": `defineAdmin({ entities: adminEntitiesOf(db), db })`. The
 * handle's set is the one `x g entity` adds to, so a new entity is a new admin resource with no
 * second registration.
 *
 * An entity keyed on more than one column is left out: a route id and an `AdminRepo` id carry one
 * string. Name it in `entities` yourself and `defineAdmin` refuses it out loud
 * (`X_ADMIN_FIELD_UNSUPPORTED`) — this helper is "everything that can be a screen", not a claim
 * that everything is. Handle order, which is the order the app declared.
 */
export function adminEntitiesOf(db: AdminDb): readonly AdminEntity[] {
  const found: AdminEntity[] = [];
  for (const name of adminTablesOf(db).keys()) {
    const declared = getEntity(name)?.core;
    if (declared !== undefined && declared.$primaryKey.length === 1) found.push(declared);
  }
  return found;
}
