// Single responsibility: turn repository arguments into the `QueryPlan` a driver executes.
// It sits outside both drivers because memory and Postgres must agree on what a call means —
// which rows are in scope, what the total sort order is, how big a page is. A guard only one
// driver applies is worse than none: the test passes and production leaks another tenant's rows.

import type { EntityCore } from './entity';
import { EntityError, invariantViolated, patchEmpty, writeUnfiltered } from './errors';
import type { FindManyArgs, RepoOptions } from './repo';
import type { Predicate, QueryPlan, SortKey } from './tenancy';
import { scopedPlan } from './tenancy';
import type { RowPatch } from './types';

/** A page is bounded by default; an unbounded read is a production incident waiting for traffic. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * And a page the caller DID bound is bounded too. The default above only covers a read nobody
 * sized; `limit(input.pageSize)` on a number that arrived over the wire is the same incident with
 * an argument in front of it — the statement binds it, the server answers with every row, and the
 * driver allocates and decodes all of them before the handler sees one. So the ceiling is a memory
 * bound, not a preference, and it lives here rather than in either driver because both read one
 * number or they stop meaning the same thing.
 *
 * Above `DEFAULT_BACKFILL_BATCH` (1,000) by an order of magnitude on purpose: a sweep declaring a
 * wider batch is a tuning decision, and only a page nobody could have meant is refused.
 */
export const MAX_PAGE_SIZE = 10_000;

/** Id-addressed operations need exactly one key. A composite key is addressed by every column. */
export const singleKeyOf = <Row>(entity: EntityCore<Row>, operation: string): string => {
  const [only] = entity.$primaryKey;
  if (entity.$primaryKey.length !== 1 || only === undefined) {
    throw invariantViolated(
      entity.$name,
      operation,
      `${entity.$name} has a composite primary key (${entity.$primaryKey.join(', ')}) — ` +
        // The old wording sent every reader, whatever they were doing, to `findMany({ where })`,
        // which is a read: a composite-key row looked unwritable because the one error that fires
        // on `delete(id)`/`update(id, …)` named no write. Every surface gets named now.
        'name every key column: findMany({ where }) to read, ' +
        'updateWhere({ … }, patch) to patch, deleteWhere({ … }) to remove',
    );
  }
  return only;
};

/**
 * The sort keys a read actually runs with: the caller's, then whatever the primary key still adds.
 * The primary key is always the final key — a cursor needs a total order, or two rows with the same
 * sort value straddle a page boundary.
 *
 * Exported because a chain can be judged before it runs: `inBatches()` refuses an ordering that
 * cannot carry a cursor, and it has to be looking at the order the driver will send rather than at
 * the one the caller typed.
 */
export const totalOrder = <Row>(
  entity: EntityCore<Row>,
  ordered: readonly SortKey[],
): readonly SortKey[] => [
  ...ordered,
  ...entity.$primaryKey
    .filter((property) => !ordered.some((entry) => entry.column === property))
    .map((property) => ({ column: property, direction: 'asc' as const })),
];

/**
 * What a page size has to be before a statement carries it: rows, whole, at least one and at most
 * `MAX_PAGE_SIZE`. The three refusals `assertBatchable` already applies to `inBatches(size)`, and
 * deliberately the same code and the same voice — `limit(0)` and `inBatches(0)` are one mistake in
 * two calls, and two codes would make a caller decide which to catch.
 *
 * Called from `limit()` on the chain, so the refusal lands on the line the author wrote, AND from
 * `planFor` below, so `findMany({ limit })` straight at the repository — a generated client, a
 * query, a third-party driver's caller — cannot route around it. One function, so the two can
 * never disagree about what a page may be.
 */
export const assertPageSize = (entityName: string, rows: number): void => {
  if (Number.isSafeInteger(rows) && rows >= 1 && rows <= MAX_PAGE_SIZE) return;
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.limit(${String(rows)}) — a page is a whole number of rows, at least one and at most ${MAX_PAGE_SIZE}`,
    fix: `${entityName}.limit(${DEFAULT_PAGE_SIZE})   # or, to visit every row the filter matches, ${entityName}.inBatches(1000) — one page per statement, and never a table in memory`,
  });
};

export const planFor = <Row>(entity: EntityCore<Row>, args: FindManyArgs): QueryPlan => {
  if (args.limit !== undefined) assertPageSize(entity.$name, args.limit);
  const scoped =
    args.orgId === undefined || entity.$tenantColumn === null
      ? []
      : [{ column: entity.$tenantColumn, op: 'eq', value: args.orgId } satisfies Predicate];
  return {
    entity: entity.$name,
    where: [...(args.where ?? []), ...scoped],
    orderBy: totalOrder(entity, args.orderBy ?? []),
    limit: args.limit ?? DEFAULT_PAGE_SIZE,
    ...(args.cursor === undefined || args.cursor === null ? {} : { cursor: args.cursor }),
    ...(args.select === undefined ? {} : { select: args.select }),
  };
};

/**
 * The plan for a read, scoped to the acting actor's tenant before a single row is considered. The
 * caller's own `orgId` is not what scopes it — it is checked against the actor and refused when it
 * disagrees (`X_TENANCY_ACTOR_MISMATCH`), because an `orgId` that arrived as action input is a
 * value the caller chose.
 */
export const readPlan = <Row>(
  entity: EntityCore<Row>,
  args: FindManyArgs,
  operation: string,
): QueryPlan => scopedPlan(entity.$name, entity.$tenantColumn, operation, planFor(entity, args));

/**
 * The plan for an id-addressed write. A write is a query too: without the same guard,
 * `update(id, patch)` on a tenant-scoped entity is a cross-tenant write that no read path
 * would ever have allowed.
 */
export const idPlan = <Row>(
  entity: EntityCore<Row>,
  id: string,
  options: RepoOptions | undefined,
  operation: string,
): QueryPlan =>
  readPlan(
    entity,
    {
      ...options,
      where: [{ column: singleKeyOf(entity, operation), op: 'eq', value: id }],
      limit: 1,
    },
    operation,
  );

/**
 * The columns a filter or a patch actually names. An `undefined` property is dropped rather than
 * used: `deleteWhere({ postId })` where `postId` came back undefined must reduce to an empty
 * filter and be refused, never to `post_id = null` — or worse, on a driver that ignores the bind,
 * to no predicate at all. `updateWhere(filter, { lastReadAt })` is the same mistake, one argument
 * along, so both guards count the same way.
 */
export const namedColumns = (values: unknown): readonly (readonly [string, unknown])[] =>
  Object.entries(
    typeof values === 'object' && values !== null ? (values as Record<string, unknown>) : {},
  ).filter(([, value]) => value !== undefined);

/** The filter a filtered write is allowed to run with: never the empty one. */
const boundedWhere = <Row>(
  entity: EntityCore<Row>,
  filter: RowPatch<Row>,
  operation: string,
): Predicate[] => {
  const where = namedColumns(filter).map(
    ([column, value]): Predicate => ({ column, op: 'eq', value }),
  );
  if (where.length === 0) throw writeUnfiltered(entity.$name, operation, entity.$primaryKey);
  return where;
};

/**
 * The plan for a filtered delete. The guard order is the point: an empty filter is refused before
 * tenancy runs, so `deleteWhere({}, { orgId })` cannot pass by virtue of the org predicate the
 * framework added — that predicate bounds the blast radius to one tenant, which is still every
 * row that tenant has.
 *
 * `limit` is the read default and is not a bound on the delete: neither driver pages a delete.
 */
export const deletePlan = <Row>(
  entity: EntityCore<Row>,
  filter: RowPatch<Row>,
  options: RepoOptions | undefined,
  operation: string,
): QueryPlan =>
  readPlan(entity, { ...options, where: boundedWhere(entity, filter, operation) }, operation);

/**
 * The plan for a filtered update. Same filter guard as the delete, from the same function, plus
 * the patch: a write that names no columns is refused rather than counted, because "4 rows
 * updated" for a statement that set nothing is the answer nobody can act on.
 */
export const updatePlan = <Row>(
  entity: EntityCore<Row>,
  filter: RowPatch<Row>,
  patch: RowPatch<Row>,
  options: RepoOptions | undefined,
  operation: string,
): QueryPlan => {
  const where = boundedWhere(entity, filter, operation);
  if (namedColumns(patch).length === 0) {
    throw patchEmpty(entity.$name, operation, Object.keys(entity.$columns));
  }
  return readPlan(entity, { ...options, where }, operation);
};
