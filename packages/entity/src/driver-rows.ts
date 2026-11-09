// Single responsibility: rows as the driver kit reads them — `selectRows`, the whole read half of
// an in-process store in one call; the projection `select` asks for; and the scope check every
// row a custom store returns passes before a caller sees it. Every meaning is borrowed:
// `matchesPredicate` and `compareByKind` are the memory driver's, which is Postgres' by parity.

import { kindOf, valueAt } from './cursor';
import type { DriverRead } from './driver-kit-types';
import type { EntityCore } from './entity';
import { compareByKind, matchesPredicate } from './memory-match';
import type { Predicate, QueryPlan } from './tenancy';

/** Lexicographic over the plan's sort keys, direction applied. */
const compareRows = <Row>(entity: EntityCore<Row>, plan: QueryPlan, a: unknown, b: unknown) => {
  for (const entry of plan.orderBy) {
    const order = compareByKind(
      kindOf(entity, entry.column),
      valueAt(a, entry.column),
      valueAt(b, entry.column),
    );
    if (order !== 0) return entry.direction === 'desc' ? -order : order;
  }
  return 0;
};

/**
 * Whether `row` sorts strictly after the cursor's values, by the COLUMN's kind (the seek was
 * revived from it, `cursor.ts`): one rule for this kit and the memory driver's binary search.
 */
export const afterSeek = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  row: unknown,
  seek: readonly unknown[],
): boolean => {
  for (const [index, entry] of plan.orderBy.entries()) {
    const order = compareByKind(
      kindOf(entity, entry.column),
      valueAt(row, entry.column),
      seek[index],
    );
    if (order !== 0) return (entry.direction === 'desc' ? -order : order) > 0;
  }
  return false;
};

/**
 * A `DriverRead` answered over rows held in process: every predicate, the total order, the
 * cursor position and the page bound. A key-value or document store that cannot evaluate a plan
 * natively hands its candidate rows here and returns what comes back.
 */
export const selectRows = <Row>(
  entity: EntityCore<Row>,
  rows: Iterable<Row>,
  read: Pick<DriverRead, 'plan' | 'after' | 'limit'>,
): Row[] => {
  const { plan, after } = read;
  const matched = [...rows]
    .filter((row) => plan.where.every((predicate) => matchesPredicate(entity, row, predicate)))
    .sort((a, b) => compareRows(entity, plan, a, b));
  const from =
    after === undefined ? matched : matched.filter((row) => afterSeek(entity, plan, row, after));
  return from.slice(0, read.limit);
};

/**
 * What `select` returns, as `pg-sql.ts`'s projection reads it: the asked properties, the primary
 * key and the top-level sort keys — without those the page could not mint its next cursor.
 */
export const projectRow = <Row>(entity: EntityCore<Row>, plan: QueryPlan, row: Row): Row => {
  if (plan.select === undefined) return row;
  const wanted = new Set([
    ...plan.select,
    ...entity.$primaryKey,
    ...plan.orderBy.map((entry) => entry.column.split('.')[0] ?? entry.column),
  ]);
  const source = row as Record<string, unknown>;
  // Built from the row's own keys, so a property the row never held stays absent, as in Postgres.
  return Object.fromEntries(
    Object.keys(source)
      .filter((key) => wanted.has(key))
      .map((key) => [key, source[key]]),
  ) as Row;
};

/**
 * The predicates a returned row MUST satisfy whatever the store's own semantics: the tenant, the
 * soft-delete stamp and the primary key. The caller's other predicates are the store's to mean —
 * a collation may differ — but these three are the framework's, and a row failing one is a leak.
 */
export const structuralPredicates = <Row>(
  entity: EntityCore<Row>,
  plan: QueryPlan,
  softDeleteColumn: string,
): readonly Predicate[] =>
  plan.where.filter(
    (predicate) =>
      (predicate.column === entity.$tenantColumn && predicate.op === 'eq') ||
      (predicate.column === softDeleteColumn && predicate.op === 'is-null') ||
      (entity.$primaryKey.includes(predicate.column) && predicate.op === 'eq'),
  );

/** The first structural predicate `row` fails, by column; `undefined` when it is in scope. */
export const outOfScope = <Row>(
  entity: EntityCore<Row>,
  structural: readonly Predicate[],
  row: unknown,
): string | undefined =>
  structural.find((predicate) => !matchesPredicate(entity, row, predicate))?.column;
