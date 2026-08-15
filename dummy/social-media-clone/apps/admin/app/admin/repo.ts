// The dashboard's only door to the database: one `AdminRepo` per entity, derived generically so a
// fourth resource is a one-line call rather than a fourth adapter. Nothing else in apps/admin may
// import the database — a page that did would be X_BOUNDARY_ROUTE_TO_DB.

import { driver, schema } from '@social-media-clone/db';
import type { AdminFilter, AdminListQuery, AdminRepo, AdminRow } from '@ultimat3/admin';
import type { ColumnMap, Entity, IdOf, Operator, Predicate, SortKey } from '@ultimat3/entity';
import { invariantViolated } from '@ultimat3/entity';

/** `contains` is the admin's word for it; `like` with both wildcards is what a driver runs. */
const OPERATOR_OF: Readonly<Record<AdminFilter['op'], Operator>> = {
  eq: 'eq',
  neq: 'neq',
  contains: 'like',
  gt: 'gt',
  lt: 'lt',
  in: 'in',
  'is-null': 'is-null',
};

const predicateOf = (filter: AdminFilter): Predicate => ({
  column: filter.field,
  op: OPERATOR_OF[filter.op],
  value: filter.op === 'contains' ? `%${String(filter.value)}%` : filter.value,
});

/**
 * A cursor carries its position as a STRING (`pagination.ts` stringifies a Date to ISO), while the
 * column it seeks on holds a Date or a number. Comparing the two would fall through to
 * `String(date)` — `"Mon Mar 02 2026…"` against `"2026-03-02T…"` — and page two would start in the
 * wrong place. So the bound is coerced back to the column's own kind before it becomes a predicate.
 */
const coerce = (columns: ColumnMap, field: string, value: string): unknown => {
  const kind = columns[field]?.$meta.kind;
  if (kind === 'timestamptz') return new Date(value);
  if (kind === 'integer' || kind === 'bigint') return Number(value);
  if (kind === 'boolean') return value === 'true';
  return value;
};

/**
 * `after`+asc and `before`+desc walk forward; the other two walk back. Written as one XOR rather
 * than a four-branch table, because the four branches are the same fact said twice.
 */
const seekOf = (columns: ColumnMap, query: AdminListQuery): readonly Predicate[] => {
  const bound = query.after ?? query.before;
  if (bound === undefined) return [];
  const forward = (query.after !== undefined) !== (query.sort.direction === 'desc');
  return [
    {
      column: bound.field,
      // `gte`/`lte`, not `gt`/`lt`: rows sharing the boundary's sort value are still on the far
      // side of it, and `dropThroughTie` below is what removes the ones already served.
      op: forward ? 'gte' : 'lte',
      value: coerce(columns, bound.field, bound.value),
    },
  ];
};

/**
 * Drop everything up to and including the cursor row. `Predicate` cannot express the row-value
 * comparison `(sort, id) > (value, id)` a keyset needs, and the alternative — a strict `gt` on the
 * sort column alone — silently skips every row that ties with the boundary.
 */
const dropThroughTie = <Row extends AdminRow>(
  rows: readonly Row[],
  query: AdminListQuery,
  idField: string,
): readonly Row[] => {
  const bound = query.after ?? query.before;
  if (bound === undefined) return rows;
  const at = rows.findIndex((row) => String(row[idField]) === bound.id);
  return at === -1 ? rows : rows.slice(at + 1);
};

const sortOf = (query: AdminListQuery, idField: string): readonly SortKey[] => [
  { column: query.sort.field, direction: query.sort.direction },
  // The tie-break, always: a page boundary on a partial order repeats or drops a row.
  { column: idField, direction: query.sort.direction },
];

/**
 * One entity → one `AdminRepo`. The entity's own `$parse` is what turns the admin's validated
 * `Record<string, unknown>` back into a row: it fills declared defaults and re-checks every column,
 * so nothing reaches the driver that the schema would not have accepted.
 */
export function adminRepoFor<Row extends AdminRow, C extends ColumnMap>(
  entity: Entity<Row, C>,
): AdminRepo<Row> {
  // The SAME repo instance `db.<entity>` wraps: `memoryDriver()` memoizes by entity name, and
  // `client.ts` exports the driver precisely so a second caller reads the store the first writes.
  const repo = driver.repo(entity);
  const idField = entity.$primaryKey[0] ?? 'id';
  const idColumn = entity.$columns[idField];
  /**
   * `AdminRepo` carries `id: string` — a URL param, untyped by nature — while `Repo<Row>` wants
   * `IdOf<Row>`. The primary key column's OWN `$parse` is what earns the crossing: `/posts/nope`
   * is rejected here, at the door, instead of reaching the driver as a cast nobody made good on.
   * `entity.$parse` cannot answer for it — that validates a whole row, not one id. The assertion
   * afterwards adds nothing to check: a brand is a compile-time tag with no runtime witness, and
   * the string it tags has already been through the column's guard.
   */
  const idOf = (id: string): IdOf<Row> => {
    const parsed = idColumn === undefined ? id : idColumn.$parse(id);
    if (typeof parsed !== 'string') {
      throw invariantViolated(entity.$name, idField, `expected a string id, got ${typeof parsed}`);
    }
    return parsed as IdOf<Row>;
  };

  return {
    async list(query: AdminListQuery): Promise<readonly Row[]> {
      const page = await repo.findMany({
        where: [...(query.where ?? []).map(predicateOf), ...seekOf(entity.$columns, query)],
        orderBy: sortOf(query, idField),
        // One over the requested page so the tie-drop cannot hand back a short page.
        limit: query.limit + 1,
      });
      return dropThroughTie(page.rows, query, idField).slice(0, query.limit);
    },
    // `async`, so a refused id arrives as a rejection: these return promises, and a caller that
    // chains `.catch()` instead of `await`ing would never see a synchronous throw.
    find: async (id) => repo.findById(idOf(id)),
    create: (input) => repo.insert(entity.$parse(input)),
    async update(id, patch) {
      const before = await repo.findById(idOf(id));
      // Re-parsed as a whole row: a patch validated field-by-field can still leave the row
      // violating an invariant that spans two columns.
      return repo.update(idOf(id), entity.$parse({ ...(before ?? {}), ...patch }));
    },
    destroy: async (id) => repo.delete(idOf(id)),
    count: (where) => repo.count({ where: (where ?? []).map(predicateOf) }),
  };
}

export const usersAdminRepo = adminRepoFor(schema.users);
export const postsAdminRepo = adminRepoFor(schema.posts);
export const mediaAdminRepo = adminRepoFor(schema.media);

/** The uploads breakdown the ops page reads. Counted through the same repo the list page uses. */
export const mediaStateCounts = async (): Promise<Readonly<Record<string, number>>> => {
  const states = ['pending', 'attached', 'orphan'] as const;
  const counts: Record<string, number> = {};
  for (const state of states) {
    counts[state] =
      (await mediaAdminRepo.count?.([{ field: 'state', op: 'eq', value: state }])) ?? 0;
  }
  return counts;
};
