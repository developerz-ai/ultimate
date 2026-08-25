// Single responsibility: the DDL an entity's INDEX declaration becomes — the `create index` a
// declaration writes out, what makes two definitions the same index, and what a moved definition
// rebuilds. Split out of `generate.ts` at the 500-line ceiling, along the seam `check-ddl.ts` and
// `generated-column.ts` already drew: `generate.ts` assembles a plan, this file writes the index
// statements it puts in it, and `invariant-ddl.ts` decides which indexes a table declares.

import { assert } from '@ultimat3/core';
import type { EntityDescriptionLike, IndexDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import { declaredMethod, indexMethodOf, indexMethodSql } from './index-method';
import type { IndexDescription } from './introspect';
import { identifier } from './sql';

/**
 * A `unique` column clause already creates an index, and Postgres names it exactly what the
 * entity's own convention names it — `<table>_<column>_key`. Emitting `create unique index` for
 * it too is the same index twice: `42P07`, and a migration that cannot be applied at all.
 * Mirrors the rule `entity()` already applies to a foreign key indexing its own column.
 *
 * A **partial** unique index is not that index: the column clause constrains every row, so
 * skipping the partial one would silently widen the constraint the entity declared.
 */
export function impliedByColumnClause(
  entity: EntityDescriptionLike,
  index: IndexDescriptionLike,
  added: ReadonlySet<string>,
): boolean {
  const [only] = index.columns;
  if (!index.unique || index.where !== null || index.columns.length !== 1 || only === undefined) {
    return false;
  }
  const column = entity.columns.find((each) => each.column === only);
  // `columnClause` writes `unique` under exactly this condition — keep the two in step.
  //
  // NOT an optional chain, despite what biome's useOptionalChain suggests: `column?.unique` is
  // `boolean | undefined`, and this function returns `boolean`. The lint rule marks its own fix
  // unsafe for exactly this reason — applying it turned a green typecheck red.
  // biome-ignore lint/complexity/useOptionalChain: an optional chain widens the return to include undefined
  return column !== undefined && column.unique && !column.primaryKey && added.has(only);
}

/**
 * Every part of the declaration reaches the statement: the whole column list in its declared
 * order, the direction when one was asked for, and the predicate that makes it partial. A part
 * dropped here is a constraint the database does not hold or an index the planner cannot use.
 */
export function createIndex(table: string, index: IndexDescriptionLike): string {
  assert(
    index.columns.length > 0,
    `index "${index.name}" on "${table}" names no columns`,
    `indexes: [{ on: ['<column>'] }]   # name the columns in the entity(), then x db gen`,
  );
  const method = index.using ?? 'btree';
  // Two rules Postgres has and a declaration can break, refused here rather than at migrate time:
  // GIN supports neither a unique index nor an ASC/DESC option, and either one reaches the server
  // as a syntax error inside `ROLE=migrate` — a release phase that fails with the server's words
  // and none of the entity's. `X_INVARIANT` for the reason `createIndex` already uses it on an
  // index naming no columns: a declaration this build cannot honour is refused, never reinterpreted.
  assert(
    method === 'btree' || !index.unique,
    `index "${index.name}" on "${table}" is unique and ${method}; Postgres has no unique ${method} index`,
    `indexes: [{ on: ['<column>'], using: '${method}' }]   # drop unique, or drop using`,
  );
  assert(
    method === 'btree' || index.order === null,
    `index "${index.name}" on "${table}" is ${method} and ${index.order}; only a btree orders its keys`,
    `indexes: [{ on: ['<column>'], using: '${method}' }]   # drop order, or drop using`,
  );
  const kind = index.unique ? 'create unique index' : 'create index';
  const direction = index.order === null ? '' : ` ${index.order}`;
  const columns = index.columns
    .map((column) => `${identifier(column).text}${direction}`)
    .join(', ');
  const predicate = index.where === null ? '' : ` where (${index.where})`;
  // Re-derived from the closed set, never spliced: `indexMethodSql` answers `''` for a btree, so
  // an index that declared no method emits the statement this generator always emitted, byte for
  // byte, and one that declared a method Postgres does not have is refused instead of built.
  return (
    `${kind} ${identifier(index.name).text} on ${identifier(table).text}` +
    `${indexMethodSql(method)} (${columns})${predicate};`
  );
}

/** `drop index "n";` — the one spelling, so a drop and its recreate cannot name it differently. */
export const dropIndex = (name: string): string => `drop index ${identifier(name).text};`;

/**
 * A RECORDED index as a declaration this generator can emit again — `declaredMethod`, never a
 * cast: the recorded side is typed open because the catalog shares the shape, and a method this
 * generator cannot write must refuse rather than be rebuilt as a btree. One copy, because
 * `redefineIndex`'s `down` and `retype-dependents.ts`'s restore ask the same question.
 */
export function asDeclared(index: IndexDescription): IndexDescriptionLike {
  return {
    name: index.name,
    columns: index.columns,
    unique: index.unique,
    where: index.where,
    order: index.order,
    ...(index.using === undefined ? {} : { using: declaredMethod(index.using) }),
  };
}

/** The parts of an index Postgres cannot alter in place — every one of them is a rebuild. */
export function indexShape(index: IndexDescriptionLike | IndexDescription): string {
  return JSON.stringify([
    [...index.columns],
    index.unique,
    index.where,
    index.order ?? null,
    indexMethodOf(index),
  ]);
}

/**
 * A same-named index whose definition moved is dropped and recreated, because Postgres has no
 * `alter index` for any of it — the column list, the uniqueness, the predicate and the direction
 * are all fixed at creation.
 *
 * Matching on the name alone was the gap: `where` and `order` were not even recorded, so an
 * entity narrowing an index to a predicate, or reversing it to `desc`, generated an empty
 * migration and the database kept serving the old one. Both sides here are *generated* spellings
 * — `recorded` is a previous migration's own snapshot, never the catalog's rewriting of it — so a
 * text difference in `where` is a real change and not a formatting one.
 */
export function redefineIndex(
  table: string,
  index: IndexDescriptionLike,
  recorded: IndexDescription,
  plan: Plan,
): void {
  if (indexShape(index) === indexShape(recorded)) return;
  plan.up.push(dropIndex(index.name), createIndex(table, index));
  // `down` is reversed at assembly, so the pair is pushed forwards and read backwards: recreating
  // the recorded definition is what must land last, after the new one is dropped.
  plan.down.push(createIndex(table, asDeclared(recorded)), dropIndex(index.name));
}
