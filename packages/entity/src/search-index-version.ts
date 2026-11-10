// A search document's VERSION: the row's `onUpdateNow()` instant, epoch ms — STRICTLY increasing
// per row. `touch()` stamps it from `entityNow()`, and every driver writes it no earlier than the
// stored value + 1 ms (`advanceVersion`, `pg-write-sql.ts`'s `greatest`), so two writes inside one
// millisecond are two versions and an index can keep only newer without losing the second.

import type { EntityCore } from './entity';
import { EntityError } from './errors';

/**
 * The property a searchable entity is versioned by: its first `onUpdateNow()` timestamp. Refused
 * when there is none — without it no index can tell a `reindex` batch's stale read from a write.
 */
export const searchVersionColumn = (entity: EntityCore<unknown>): string => {
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.kind === 'timestamptz' && column.$meta.onUpdate !== undefined) return property;
  }
  throw new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entity.$name} is searchable but declares no onUpdateNow() column, so a search document has no version and an index cannot refuse a stale one`,
    fix: `updatedAt: timestamp().defaultNow().onUpdateNow()   # in entity('${entity.$name}'), then: x db gen "version ${entity.$name} for search"`,
  });
};

/** How far a write moves a version past the stored one when the clock has not: one millisecond. */
export const VERSION_STEP_MS = 1;

/**
 * The property a write of `entity` must ADVANCE, or `undefined`: the version column of a
 * searchable entity. Every other `onUpdateNow()` column is the clock's reading, unchanged.
 */
export const advancingVersionColumn = (entity: EntityCore<unknown>): string | undefined => {
  if (entity.$search === null) return undefined;
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.kind === 'timestamptz' && column.$meta.onUpdate !== undefined) return property;
  }
  return undefined;
};

/**
 * A soft delete's stamp: `deletedAt`, plus the version column of a searchable entity — a deletion
 * is a write, so it advances the version too (`advanceVersion`, `greatest(…)` in the statement), and
 * the tombstone sits past it.
 */
export const deletionStamp = (
  entity: EntityCore<unknown>,
  softDeleteColumn: string,
  now: Date,
): Readonly<Record<string, Date>> => {
  const version = advancingVersionColumn(entity);
  return version === undefined
    ? { [softDeleteColumn]: now }
    : { [softDeleteColumn]: now, [version]: now };
};

/**
 * `merged` with its version no earlier than `stored`'s + `VERSION_STEP_MS`, when the write named
 * the version column (`named`) — the memory driver's and a custom store's half of the rule; the
 * Postgres statement says it as `greatest(…)`.
 */
export const advanceVersion = <Row>(
  entity: EntityCore<Row>,
  stored: Row,
  merged: Row,
  named: (property: string) => boolean,
): Row => {
  const property = advancingVersionColumn(entity as EntityCore<unknown>);
  if (property === undefined || !named(property)) return merged;
  const before = instantMs((stored as Readonly<Record<string, unknown>>)[property]);
  const after = instantMs((merged as Readonly<Record<string, unknown>>)[property]);
  if (before === undefined || after === undefined || after > before) return merged;
  return Object.assign({}, merged, { [property]: new Date(before + VERSION_STEP_MS) }) as Row;
};

const instantMs = (value: unknown): number | undefined => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return undefined;
};

/** The version of one row of `entity`: its version column, epoch ms. */
export const searchVersionOf = <Row>(entity: EntityCore<Row>, row: Row): number => {
  const core = entity as EntityCore<unknown>;
  const property = searchVersionColumn(core);
  const ms = instantMs((row as Readonly<Record<string, unknown>>)[property]);
  if (ms === undefined || !Number.isFinite(ms)) {
    throw new EntityError({
      code: 'X_INVARIANT_VIOLATED',
      cause: `a ${entity.$name} row reached the search index without its ${property} instant, so its document has no version`,
      fix: `searchDocumentOf(${entity.$name}, await db.${entity.$name}.findById(id))   # the whole row: a select() that drops ${property} has no version`,
    });
  }
  return ms;
};
