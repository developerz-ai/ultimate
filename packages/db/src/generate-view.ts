// Single responsibility: the views `x db gen` writes — `entity(name, { view: { sql } })` emitted
// as `create [materialized] view`, recorded in the snapshot, and re-emitted whole when anything
// they could depend on moves. Split from `generate.ts`, which hands every table to its own arms and
// every view to this file, so no table arm (keys, row security, triggers) ever sees a view.

import type { EntityDescriptionLike } from './entity-shape';
import type { Plan } from './foreign-key-plan';
import { createIndex } from './index-ddl';
import type { SchemaDescription, ViewDescription } from './introspect';
import { declaredIndexes } from './invariant-ddl';
import { identifier } from './sql';

/** Tables first, views second — the partition every arm of `generateMigration` reads. */
export function splitViews(entities: readonly EntityDescriptionLike[]): {
  readonly tables: readonly EntityDescriptionLike[];
  readonly views: readonly EntityDescriptionLike[];
} {
  return {
    tables: entities.filter((entity) => entity.view === undefined),
    views: entities.filter((entity) => entity.view !== undefined),
  };
}

/** The author's query as one statement body: no trailing `;`, no trailing whitespace. */
const bodyOf = (sql: string): string => sql.trim().replace(/;\s*$/, '');

/**
 * What a declared view records: its statements, verbatim — the comparison `x db gen` makes next
 * time is between two of these, so a changed query, a changed index or `materialized` flipping is
 * a different list and a rebuild. Only a MATERIALIZED view carries indexes; Postgres has none for
 * a plain one (`entity()` refuses the declaration first).
 */
export function viewDescriptionOf(entity: EntityDescriptionLike): ViewDescription {
  const materialized = entity.view?.materialized === true;
  const kind = materialized ? 'materialized view' : 'view';
  const create = [
    `create ${kind} ${identifier(entity.table).text} as ${bodyOf(entity.view?.sql ?? '')};`,
    ...(materialized
      ? declaredIndexes(entity).map((index) => createIndex(entity.table, index))
      : []),
  ];
  return { name: entity.table, ...(materialized ? { materialized: true as const } : {}), create };
}

const drop = (view: ViewDescription): string =>
  `drop ${view.materialized === true ? 'materialized view' : 'view'} if exists ${identifier(view.name).text};`;

const same = (left: readonly ViewDescription[], right: readonly ViewDescription[]): boolean =>
  left.length === right.length &&
  left.every((view, at) => JSON.stringify(view) === JSON.stringify(right[at]));

/**
 * Whether the table statements of this migration can break a view compiled against them: a
 * retype is `0A000` under a view and a dropped column or table is `2BP01`. The words are the ones
 * `generate.ts` itself writes, so this reads its own output and never an author's SQL.
 */
export const touchesViewSources = (up: readonly string[]): boolean =>
  up.some((statement) =>
    /\balter column\b.*\btype\b|\bdrop column\b|^drop table\b/.test(statement),
  );

/** What a view rebuild contributes: drops ahead of every table statement, creates after them. */
export interface ViewPlan {
  readonly before: Plan;
  readonly after: Plan;
}

/**
 * Every recorded view is dropped (last declared first) and every declared one created (in
 * declaration order — a view reading another view is declared after it) whenever the list moved
 * or the tables under it did. Whole, never one view: which views read which is in their SQL, and
 * a rebuild of the one that changed would leave its dependents compiled against the old one —
 * `X_MIGRATION_VIEW_DEPENDS` is what that looks like at deploy. A materialized view comes back
 * populated, so a rebuild costs one refresh, and nothing at all when nothing moved.
 */
export function viewPlan(
  views: readonly EntityDescriptionLike[],
  current: SchemaDescription,
  tableUp: readonly string[],
): ViewPlan {
  const wanted = views.map(viewDescriptionOf);
  const recorded = current.views ?? [];
  const before: Plan = { up: [], down: [] };
  const after: Plan = { up: [], down: [] };
  if (same(wanted, recorded) && !(recorded.length > 0 && touchesViewSources(tableUp))) {
    return { before, after };
  }
  for (const view of [...recorded].reverse()) before.up.push(drop(view));
  // `down` is reversed whole by the caller, so it is written backwards here: what comes out is
  // every recorded view recreated in its own order, after every table is back.
  before.down.push(...recorded.flatMap((view) => view.create).reverse());
  for (const view of wanted) {
    after.up.push(...view.create);
    after.down.push(drop(view));
  }
  return { before, after };
}
