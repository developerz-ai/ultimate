// Single responsibility: what a grouped count is made of — which columns a count may be keyed by,
// how many groups one statement is allowed to answer with, and the order the map comes back in.
// Both drivers read those three rules from here, so a `countBy` against memory means exactly what
// a `countBy` against Postgres means; a rule added to one driver alone is the drift this file
// exists to prevent.

import { columnFor } from './column';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import type { AnyColumn, ColumnKind } from './types';

/**
 * How many groups one call may answer with. A grouped count answers a page's worth of keys, or a
 * column with a handful of values; past that it is a report, and a report is paged. The statement
 * therefore asks for one group more than this and the extra one is *refused* rather than dropped —
 * a map that silently lost its tail reads exactly like a complete one, and a caller recounting
 * from it would write the wrong number to every row it missed.
 */
export const MAX_GROUPS = 1000;

/**
 * The kinds a group key can be. A `Map` compares keys by identity for anything that is not a
 * primitive, so a `timestamptz` (a `Date`) or a `jsonb` (an object) would file every row under a
 * key no caller can look up again — the result would be a map that only ever answers `undefined`.
 * `money` is two physical columns, which is not one value to group by at all.
 */
const GROUPABLE: ReadonlySet<ColumnKind> = new Set<ColumnKind>([
  'uuid',
  'text',
  'char',
  'boolean',
  'integer',
  'bigint',
]);

const groupableColumns = <Row>(entity: EntityCore<Row>): readonly string[] =>
  Object.entries(entity.$columns)
    .filter(([, column]) => GROUPABLE.has(column.$meta.kind))
    .map(([property]) => property);

/**
 * Not `invariantViolated`: its fix opens `x entity explain`, which describes invariants nobody
 * wrote here. What repairs this is one edit to the call — a different column, named in the message
 * because the entity is the only place the answer lives. Only when this entity offers no such
 * column does the fix become a command, and then it is `x entities describe`, which prints the
 * kinds: there is no call to suggest, since every column it declares would be refused the same way.
 */
const notGroupable = <Row>(
  entity: EntityCore<Row>,
  operation: string,
  property: string,
  reason: string,
): EntityError => {
  const [first] = groupableColumns(entity);
  return new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name}.${operation}('${property}'): ${reason}`,
    fix:
      first === undefined
        ? `x entities describe ${entity.$name} --json   # this entity declares no column a count can be keyed by`
        : `${entity.$name}.${operation}('${first}')   # group by one of: ${groupableColumns(entity).join(', ')}`,
  });
};

/**
 * The bound, spelled as the call that stays under it. A grouped count of a foreign key is the
 * point of this method, so the fix leads with the `in` predicate that bounds one — the shape a
 * page-then-count loop collapses to.
 */
const tooManyGroups = <Row>(
  entity: EntityCore<Row>,
  operation: string,
  property: string,
): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name}.${operation}('${property}') matched more than ${MAX_GROUPS} distinct values — that column is a key, not a grouping`,
    fix: `${entity.$name}.andWhere('${property}', 'in', <values>).${operation}('${property}')   # bound the values first; a whole-table breakdown is a report, and a report is paged`,
  });

/**
 * The column a count may be keyed by, or the refusal. Called by both drivers before the statement
 * exists, so an ungroupable column is the same error whichever one is installed.
 */
export const groupColumnOf = <Row>(
  entity: EntityCore<Row>,
  property: string,
  operation: string,
): AnyColumn => {
  const column = columnFor(entity.$columns, property);
  if (column === undefined) {
    throw notGroupable(
      entity,
      operation,
      property,
      `no column "${property}" on ${entity.$name} — pick from: ${Object.keys(entity.$columns).join(', ')}`,
    );
  }
  if (!GROUPABLE.has(column.$meta.kind)) {
    throw notGroupable(
      entity,
      operation,
      property,
      `a ${column.$meta.kind} column is not a key a map can be looked up by`,
    );
  }
  return column;
};

/**
 * The value a group is filed under: re-parsed by the column that declared it, exactly as
 * `decodeRow` re-parses a row's own value — `int8` arrives as a string and would otherwise key the
 * map by text where the in-memory driver keys it by a `bigint`. An absent value is `null`, which
 * is the one group SQL's `group by` puts every NULL row in.
 */
export const groupValue = (column: AnyColumn, value: unknown): unknown =>
  value === null || value === undefined ? null : column.$parse(value);

/** Ties: numbers and bigints numerically, everything else by its text, `null` last. */
const byValue = (left: unknown, right: unknown): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The map both drivers hand back: the biggest group first, ties by the value itself, `null` last.
 * Ordered here rather than in the statement, because there is no order to inherit — a hash
 * aggregate returns groups in whatever order it built them and a `Map` filled row by row returns
 * them in insertion order, so the two drivers would disagree about a result they agree on.
 * Sorting the groups (never the rows) costs nothing at this size and it is what makes
 * "the largest bucket" readable off the front.
 */
export const countsFrom = <Row>(
  entity: EntityCore<Row>,
  property: string,
  operation: string,
  groups: readonly (readonly [unknown, number])[],
): ReadonlyMap<unknown, number> => {
  if (groups.length > MAX_GROUPS) throw tooManyGroups(entity, operation, property);
  return new Map(
    [...groups].sort((left, right) => right[1] - left[1] || byValue(left[0], right[0])),
  );
};
