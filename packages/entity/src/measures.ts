// Single responsibility: what a multi-measure aggregate MEANS — the measure shape, which ones a call
// may ask for, and how each is judged before either driver builds anything. Both drivers plan from
// here, so `aggregate({ … })` is the same refusal and the same answer against memory and Postgres.

import { type AggregateFn, aggregateColumnOf } from './aggregate';
import { columnFor } from './column';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import { screenPredicates } from './predicate-screen';
import type { FindManyArgs } from './repo';
import type { Predicate } from './tenancy';
import type { AnyColumn } from './types';

/** `count`, then the four `aggregate.ts` already defines. A sixth is a member there first. */
export type MeasureFn = 'count' | AggregateFn;

/**
 * One output of `aggregate({ name: measure })`. `count` without a column is `count(*)`; with one it
 * counts that column's non-null values. `where` narrows THIS measure only — `count(*) filter (where
 * …)` — inside the rows the chain already matched, so tenancy and soft delete still bound it.
 */
export interface Measure {
  readonly fn: MeasureFn;
  readonly column?: string;
  readonly where?: readonly Predicate[];
}

export type MeasureMap = Readonly<Record<string, Measure>>;

/** `countBy(column, args, { where })`: each group's count of the rows that satisfy `where`. */
export interface CountByOptions {
  readonly where?: readonly Predicate[];
}

/** The repository member both drivers add — optional on `Repo`, so a hand-written driver compiles. */
export interface MeasureReads {
  aggregates(measures: MeasureMap, args?: FindManyArgs): Promise<Readonly<Record<string, unknown>>>;
}

/**
 * How many measures one statement carries. A dashboard tile asks for a handful; past this it is a
 * report, and the select list of one statement is not where a report is built.
 */
export const MAX_MEASURES = 32;

const FNS: ReadonlySet<unknown> = new Set<MeasureFn>(['count', 'sum', 'avg', 'min', 'max']);

/** A measure judged: its name, its function, the column it reads (absent for `count(*)`). */
export interface PlannedMeasure {
  readonly name: string;
  readonly fn: MeasureFn;
  readonly property: string | undefined;
  readonly column: AnyColumn | undefined;
  readonly where: readonly Predicate[];
}

const EXAMPLE = "aggregate({ total: { fn: 'count' }, paid: { fn: 'sum', column: '<column>' } })";

const refused = <Row>(entity: EntityCore<Row>, cause: string, fix?: string): EntityError =>
  new EntityError({
    code: 'X_AGGREGATE_UNSUPPORTED',
    cause: `${entity.$name}.aggregate(…): ${cause}`,
    fix: fix ?? `${entity.$name}.${EXAMPLE}`,
  });

/** A value from an app, rendered so building the message cannot throw instead of refusing. */
const shown = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'` : value === null ? 'null' : `a ${typeof value}`;

/**
 * Filters judged as the chain's own are: an operator outside the vocabulary, a whole money value.
 * A column the entity never declared is refused too — `physicalName` would refuse it in Postgres
 * and memory would read `undefined` as NULL and answer zero.
 */
export const screenMeasureFilter = <Row>(
  entity: EntityCore<Row>,
  where: readonly Predicate[],
): readonly Predicate[] => {
  if (!Array.isArray(where)) {
    throw refused(entity, `a measure's where is ${shown(where)}, not a list of predicates`);
  }
  screenPredicates(entity, where);
  for (const predicate of where) {
    const [property = predicate.column] = predicate.column.split('.');
    if (predicate.op !== 'matches' && columnFor(entity.$columns, property) === undefined) {
      throw refused(
        entity,
        `a measure filters on "${predicate.column}", which ${entity.$name} does not declare`,
        `x entities show ${entity.$name} --json   # the columns a filter can name`,
      );
    }
  }
  return where;
};

const planOne = <Row>(entity: EntityCore<Row>, name: string, measure: unknown): PlannedMeasure => {
  if (typeof measure !== 'object' || measure === null) {
    throw refused(entity, `measure '${name}' is ${shown(measure)}, not { fn, column?, where? }`);
  }
  const { fn, column, where = [] } = measure as Partial<Measure>;
  if (!FNS.has(fn)) {
    throw refused(
      entity,
      `measure '${name}' names fn ${shown(fn)} — one of: ${[...FNS].join(', ')}`,
    );
  }
  const filter = screenMeasureFilter(entity, where);
  if (fn === 'count') {
    if (column === undefined)
      return { name, fn, property: undefined, column: undefined, where: filter };
    const declared = columnFor(entity.$columns, column);
    if (declared === undefined) {
      throw refused(
        entity,
        `measure '${name}' counts "${column}", which ${entity.$name} does not declare`,
      );
    }
    return { name, fn, property: column, column: declared, where: filter };
  }
  if (typeof column !== 'string') {
    throw refused(entity, `measure '${name}' is ${String(fn)} with no column`);
  }
  // The same judgement `sum('title')` gets, so a kind with no aggregate is one refusal everywhere.
  const declared = aggregateColumnOf(entity, fn as AggregateFn, column);
  return { name, fn: fn as AggregateFn, property: column, column: declared, where: filter };
};

/** Every measure judged, in the order the caller wrote them — refused before any row is read. */
export const planMeasures = <Row>(
  entity: EntityCore<Row>,
  measures: MeasureMap,
): readonly PlannedMeasure[] => {
  if (typeof measures !== 'object' || measures === null || Array.isArray(measures)) {
    throw refused(entity, `the measures are ${shown(measures)}, not { name: measure }`);
  }
  const names = Object.keys(measures);
  if (names.length === 0) throw refused(entity, 'no measures — there is nothing to compute');
  if (names.length > MAX_MEASURES) {
    throw refused(
      entity,
      `${names.length} measures in one statement, past ${MAX_MEASURES}`,
      `${entity.$name}.aggregate({ … })   # split into calls of at most ${MAX_MEASURES} measures`,
    );
  }
  return names.map((name) => planOne(entity, name, measures[name]));
};

/**
 * A repository with no `aggregates` — a hand-written driver, which the contract lets omit it. The
 * fix is the equivalent the contract does guarantee: one aggregate per call.
 */
export const measuresUnsupported = (entityName: string): EntityError =>
  new EntityError({
    code: 'X_AGGREGATE_UNSUPPORTED',
    cause: `${entityName}.aggregate({ … }) reached a repository that does not implement aggregates(measures, args): a hand-written driver, which the contract lets omit it`,
    fix: `${entityName}.count() / .sum('<column>')   # one aggregate per call; or a driver that implements aggregates (postgresDriver(), memoryDriver())`,
  });
