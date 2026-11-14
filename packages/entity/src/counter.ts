// Single responsibility: what `references(() => posts.id, { countedIn: () => posts.likeCount })`
// means once both schema modules have evaluated — the parent column resolved, held to being an
// integer of the entity the key points at, and projected for `@ultimat3/db` (which emits the
// trigger) and for the memory driver (which mirrors it).

import type { CounterDescriptionLike, CounterWhereLike } from '@ultimat3/db';
import { identifier } from '@ultimat3/db';
import { bindingOf, columnName, moneyColumns } from './column';
import type { EntityCore } from './entity';
import { SOFT_DELETE_COLUMN } from './entity';
import { EntityError } from './errors';
import { type Expr, type InvariantColumns, invariantColumns, type Row } from './expr';
import { type Verdict, verdictOf } from './expr-verdict';
import { getEntity, registeredEntities, registryGeneration } from './registry';
import type { AnyColumn, ColumnMap, CountedIn } from './types';

/** One resolved counter: both entities, both properties. */
export interface Counter {
  readonly parent: EntityCore;
  /** The counting integer's property on the parent. */
  readonly column: string;
  readonly child: EntityCore;
  /** The child's foreign-key property. */
  readonly references: string;
  /** `countedIn: { where }`, compiled once: the memory driver's verdict and the trigger's SQL. */
  readonly where: {
    readonly verdict: Verdict;
    readonly sql: CounterWhereLike;
    /** The child properties it reads: a patch setting one can move the count. */
    readonly properties: readonly string[];
  } | null;
}

/** The parent column a `countedIn` names, in either spelling, and its predicate thunk. */
const targetOf = (declared: CountedIn) =>
  typeof declared === 'function'
    ? { to: declared, where: undefined }
    : { to: declared.to, where: declared.where };

const countsInvalid = (
  entity: string,
  property: string,
  reason: string,
  fix = `x db gen "count"   # after ${property}: uuid().references(() => <parent>.id, { countedIn: () => <parent>.<count> }) in entity('${entity}'), where <count> is integer().default(0)`,
): EntityError =>
  new EntityError({
    code: 'X_ENTITY_COUNTS_INVALID',
    cause: `${entity}.${property} declares countedIn, and ${reason}`,
    fix,
  });

/**
 * The `c` an invariant is written against, for an entity already declared — what a
 * `countedIn: { where }` thunk builds its predicate from: `() => whereColumns(likes).kind.eq('up')`.
 */
export const whereColumns = <C extends ColumnMap>(entity: {
  readonly $name: string;
  readonly $columns: C;
}): InvariantColumns<C> => invariantColumns(entity.$name, entity.$columns);

/**
 * A `where` compiled once against the CHILD: SQL over the child aliased `c` (the trigger and the
 * recount both give it that alias) and the physical columns it reads. A predicate with no SQL
 * (a JS function) or a `unique` is refused: the trigger would count by a rule memory does not hold.
 */
function compileWhere(child: EntityCore, property: string, rule: Expr): Counter['where'] {
  const refuse = (reason: string): never => {
    throw countsInvalid(
      child.$name,
      property,
      reason,
      `references(() => <parent>.id, { countedIn: { to: () => <parent>.<count>, where: () => whereColumns(${child.$name}).<column>.eq(<value>) } }) in entity('${child.$name}') — a predicate in the invariant language, never a function — then: x db gen "count"`,
    );
  };
  const physical = (path: readonly string[]): string => {
    const [name, part] = path;
    const column = name === undefined ? undefined : child.$columns[name];
    if (name === undefined || column === undefined) {
      return refuse(`its where names ${path.join('.')}, no column of ${child.$name}`);
    }
    if (part === undefined) return columnName(name, column.$meta);
    const parts = moneyColumns(name, column.$meta);
    return part === 'minor' ? parts.minor : parts.currency;
  };
  const sql =
    rule.kind === 'unique' ? null : rule.toSql((path) => `c.${identifier(physical(path)).text}`);
  if (sql === null) return refuse(`its where (${rule.message}) has no SQL the trigger can hold`);
  const columns = [...new Set(rule.paths.map(physical))];
  const properties = [...new Set(rule.paths.flatMap((path) => path.slice(0, 1)))];
  return { verdict: verdictOf(rule), sql: { sql, columns }, properties };
}

/** The counter one child key declares, resolved and checked. `null` when it declares none. */
export function counterOf(child: EntityCore, property: string, column: AnyColumn): Counter | null {
  const declared = column.$meta.countedIn;
  if (declared === undefined) return null;
  const target = targetOf(declared);
  const counting = target.to();
  const binding = bindingOf(counting);
  const parent = binding === undefined ? undefined : getEntity(binding.table)?.core;
  if (binding === undefined || parent === undefined) {
    throw countsInvalid(child.$name, property, 'its countedIn column belongs to no entity');
  }
  if (counting.$meta.kind !== 'integer') {
    throw countsInvalid(
      child.$name,
      property,
      `${binding.table}.${binding.property} is no integer()`,
    );
  }
  // `NULL + 1` is NULL in the trigger and memory counts from 0: a nullable count means two things.
  if (!counting.$meta.notNull) {
    throw countsInvalid(child.$name, property, `${binding.table}.${binding.property} is nullable`);
  }
  const points =
    column.$meta.references === undefined ? undefined : bindingOf(column.$meta.references());
  const key = parent.$primaryKey.length === 1 ? parent.$primaryKey[0] : undefined;
  if (points?.table !== parent.$name || points.property !== key) {
    throw countsInvalid(
      child.$name,
      property,
      `it is no foreign key to ${parent.$name}'s single primary key, so it cannot count into it`,
    );
  }
  const where = target.where === undefined ? null : compileWhere(child, property, target.where());
  return { parent, column: binding.property, child, references: property, where };
}

/**
 * Whether a child row (property-keyed, as a repository holds it) is counted by `counter`'s predicate:
 * only a TRUE verdict counts — a NULL operand is unknown, and a SQL `where` drops it. The key and
 * the soft-delete stamp are the caller's to check, as the trigger checks them first.
 */
export const countsRow = (counter: Counter, row: unknown): boolean =>
  counter.where === null ||
  (typeof row === 'object' && row !== null && counter.where.verdict(row as Row) === true);

let cached: { readonly generation: number; readonly counters: readonly Counter[] } | undefined;

/**
 * Every counter declared on the keys of every registered entity — memoised on
 * `registryGeneration()` as `relationMap()` is, because the memory driver asks on every write.
 */
export function registeredCounters(): readonly Counter[] {
  const generation = registryGeneration();
  if (cached?.generation === generation) return cached.counters;
  const counters = registeredEntities().flatMap((entry) => {
    const child = entry.core;
    if (child === undefined) return [];
    return Object.entries(child.$columns).flatMap(([property, column]) => {
      const counter = counterOf(child, property, column);
      return counter === null ? [] : [counter];
    });
  });
  cached = { generation, counters };
  return counters;
}

/** The counters kept ON `parent`'s columns. */
export const countersOf = (parent: EntityCore): readonly Counter[] =>
  registeredCounters().filter((counter) => counter.parent.$name === parent.$name);

/** The counters whose CHILD is `entity`: what a write to it must move. */
export const countersTargeting = (entity: string): readonly Counter[] =>
  registeredCounters().filter((counter) => counter.child.$name === entity);

const physical = (entity: EntityCore, property: string): string => {
  const column = entity.$columns[property];
  return column === undefined ? property : columnName(property, column.$meta);
};

/** The projection `@ultimat3/db` compiles to a trigger on the child. */
export function describeCounter(counter: Counter): CounterDescriptionLike {
  const key = counter.parent.$primaryKey[0] ?? '';
  return {
    column: physical(counter.parent, counter.column),
    key: physical(counter.parent, key),
    table: counter.child.$table,
    references: physical(counter.child, counter.references),
    softDelete: counter.child.$softDelete ? physical(counter.child, SOFT_DELETE_COLUMN) : null,
    ...(counter.where === null ? {} : { where: counter.where.sql }),
  };
}
