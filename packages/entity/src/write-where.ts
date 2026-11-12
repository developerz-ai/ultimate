// Single responsibility: the plan a FILTERED write runs — `updateWhere(filter, …)`, `deleteWhere(
// filter)` and a chain's `.updateAll(patch)`/`.deleteAll()` — built once, so the two spellings are one
// write. Every driver already executes any predicate a read plan holds; what a write adds is the
// refusal of the empty filter and of chain state (a page, a cursor, a search) it cannot honour.

import type { EntityCore } from './entity';
import { describeCommand, EntityError, patchEmpty, writeUnfiltered } from './errors';
import { namedColumns, readPlan } from './plan';
import type { FilteredWriteOptions } from './repo';
import { SEARCH_PROPERTY } from './search';
import type { Predicate, QueryPlan } from './tenancy';
import type { RowPatch } from './types';

/** What a chain carries into a write terminal. */
export interface WriteChain {
  readonly where: readonly Predicate[];
  readonly limit: number | undefined;
  readonly cursor: string | null;
}

/** A NULL test names its column and no value; every other predicate is only a filter with one. */
const named = (predicate: Predicate): boolean =>
  predicate.op === 'is-null' || predicate.op === 'is-not-null' || predicate.value !== undefined;

/**
 * The filter's equalities, then the chain's predicates. In the FILTER an `undefined` value is
 * dropped, never bound — the rule `updateWhere` has always had, kept. On a CHAIN it is refused
 * (`chainUndefined`), so it never reaches here.
 */
const boundedBy = <Row>(
  filter: RowPatch<Row>,
  options: FilteredWriteOptions | undefined,
): Predicate[] => [
  ...namedColumns(filter).map(([column, value]): Predicate => ({ column, op: 'eq', value })),
  ...(options?.where ?? []),
];

const verbOf = (op: string): 'updateAll' | 'deleteAll' =>
  op.startsWith('update') ? 'updateAll' : 'deleteAll';

/**
 * A chain predicate written with `undefined` is refused, not dropped. Dropped, `.where({ orgId,
 * postId }).deleteAll()` on a `postId` that came back undefined deletes every row the org has —
 * the remaining predicate still bounds it, so the empty-filter refusal never fires. A chain is
 * written predicate by predicate; one with no value is a bug at that line, never an intent.
 */
const chainUndefined = <Row>(
  entity: EntityCore<Row>,
  op: string,
  where: readonly Predicate[],
): EntityError | undefined => {
  const missing = where.find((predicate) => !named(predicate));
  if (missing === undefined) return undefined;
  const verb = verbOf(op);
  return new EntityError({
    code: 'X_WRITE_UNFILTERED',
    cause: `${entity.$name}.where(…).${verb}() — the predicate on ${missing.column} has an undefined value, and dropping it would widen the write to every row the rest of the chain matches`,
    fix: `db.${entity.$name}.where({ ${missing.column} }).${verb}(${verb === 'updateAll' ? '…' : ''})   # guard ${missing.column} so it is defined before the write; for SQL NULL write .andWhere('${missing.column}', 'is-null')`,
  });
};

/**
 * The fix spelled as the call the author wrote. `X_WRITE_UNFILTERED` is one situation whichever
 * spelling hit it, so it stays one code; only the line to paste differs.
 */
const unfiltered = <Row>(entity: EntityCore<Row>, op: string, chained: boolean): EntityError => {
  if (!chained) return writeUnfiltered(entity.$name, op, entity.$primaryKey);
  const verb = verbOf(op);
  return new EntityError({
    code: 'X_WRITE_UNFILTERED',
    cause: `${entity.$name}.where(…).${verb}() named no filter — an empty chain would reach every row`,
    fix: `db.${entity.$name}.where({ ${entity.$primaryKey.join(', ')} }).${verb}(${verb === 'updateAll' ? '…' : ''})   # name the columns that bound it. A deliberate whole-table write is a migration: x db gen "<name>"`,
  });
};

/**
 * The plan for a filtered delete. The empty filter is refused BEFORE tenancy runs: the org
 * predicate the framework adds bounds the blast radius to one tenant, which is still every row
 * that tenant has. Then the read's own plan — tenancy, operator screening — so a chain's
 * `.deleteAll()` reaches exactly the rows the same chain's `.all()` would read, and no other.
 */
export const writeWherePlan = <Row>(
  entity: EntityCore<Row>,
  filter: RowPatch<Row>,
  options: FilteredWriteOptions | undefined,
  op: string,
): QueryPlan => {
  const refused = chainUndefined(entity, op, options?.where ?? []);
  if (refused !== undefined) throw refused;
  const where = boundedBy(filter, options);
  if (where.length === 0) throw unfiltered(entity, op, options?.where !== undefined);
  const { where: _chain, ...rest } = options ?? {};
  return readPlan(entity, { ...rest, where }, op);
};

/**
 * The plan for a filtered update: the delete's, after the patch is judged non-empty — "4 rows
 * updated" for a statement that set nothing is the answer nobody can act on. Filter first, so the
 * order of the two refusals is the order of the arguments.
 */
export const updateWherePlan = <Row>(
  entity: EntityCore<Row>,
  filter: RowPatch<Row>,
  patch: RowPatch<Row>,
  options: FilteredWriteOptions | undefined,
  op: string,
): QueryPlan => {
  const plan = writeWherePlan(entity, filter, options, op);
  if (namedColumns(patch).length > 0) return plan;
  const columns = Object.keys(entity.$columns);
  if (options?.where === undefined) throw patchEmpty(entity.$name, op, columns);
  throw new EntityError({
    code: 'X_PATCH_EMPTY',
    cause: `${entity.$name}.where(…).updateAll() named no columns to write`,
    fix: `db.${entity.$name}.where(filter).updateAll({ <column>: <value> })   # pick a column from: ${columns.join(', ')}`,
  });
};

const unwritable = (entityName: string, verb: string, what: string, instead: string) =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.where(…).${what}.${verb}() — ${instead}`,
    fix: `${describeCommand(entityName)}   # the entity whose write chain carries ${what}: drop it, or sweep with .where(filter).inBatches(1000) and write each batch by its keys`,
  });

/**
 * A write has no page. `limit(n)` would read as "the first n" and `after(cursor)` as "past this
 * row", and neither Postgres's UPDATE/DELETE nor any other driver's honours either — so a chain
 * carrying one is refused rather than written in full. A `.search()` is refused too: an external
 * index answers at most `MAX_PAGE_SIZE` ids, and a write over a sample of the matches is a write
 * nobody asked for. The order, the projection and preloads change no row, and are ignored.
 */
export const assertWritableChain = (
  entityName: string,
  verb: 'updateAll' | 'deleteAll',
  chain: WriteChain,
): void => {
  if (chain.limit !== undefined) {
    throw unwritable(entityName, verb, 'limit()', 'a write has no page and reaches every match');
  }
  if (chain.cursor !== null) {
    throw unwritable(entityName, verb, 'after()', 'a write has no page and reaches every match');
  }
  if (chain.where.some((each) => each.column === SEARCH_PROPERTY)) {
    throw unwritable(
      entityName,
      verb,
      'search()',
      'an external search index answers a bounded sample of ids, never every match',
    );
  }
};

/** Every column a filtered write is bounded by — what `sealed-repo.ts` refuses a sealed one from. */
export const predicateColumns = (
  filter: unknown,
  where: readonly Predicate[] | undefined,
): readonly string[] => [
  ...namedColumns(filter).map(([column]) => column),
  ...(where ?? []).map((each) => each.column),
];
