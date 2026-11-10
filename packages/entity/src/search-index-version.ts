// A search document's VERSION: the row's `onUpdateNow()` instant, epoch ms. The one monotonic
// per-row value the entity layer guarantees — `touch()` stamps it on every update, upsert and
// transition from `entityNow()` — so an index can keep only newer and refuse a stale batch.

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
