// Single responsibility: the two row images of one replicated change — a physical tuple pair
// becomes the `before`/`after` the matcher's predicates are written against, plus the properties
// `after` could not carry. Split out of `pg-replication.ts`, which decides ordering and nothing else.

import { ReplicationProtocolError } from './errors';
import { isRow, type Row } from './json';
import { entityRow, omittedProperties } from './pg-entity-row';
import type { PhysicalRow } from './pg-values';
import type { PgRelation } from './pgoutput';

export interface ReplicatedImages {
  readonly before: Row | null;
  readonly after: Row | null;
  /** Properties missing from `after` because Postgres logged no value for them. Usually empty. */
  readonly omitted: readonly string[];
}

/**
 * An UPDATE that leaves an out-of-line (TOAST) value untouched logs no bytes for it, so the new
 * tuple arrives without that column. Published as it stood, the change read as the whole row: the
 * window adopted it, and every later snapshot served the row with the column gone.
 *
 * Under REPLICA IDENTITY FULL the old tuple carries the value and the column did not change, so it
 * is copied across and nothing is missing. Under any other identity the old tuple is the key alone
 * — its other columns are NULL placeholders, not values — so the column is NAMED instead, and the
 * consumer re-reads the row rather than adopting a partial one.
 */
export function replicatedImages(
  relation: PgRelation,
  oldTuple: PhysicalRow | null,
  newTuple: PhysicalRow | null,
  unchanged: readonly string[],
): ReplicatedImages {
  const before = toRow(relation, oldTuple, 'before');
  if (newTuple === null || unchanged.length === 0) {
    return { before, after: toRow(relation, newTuple, 'after'), omitted: [] };
  }
  // Null-prototype, as the decoder built it: a column name is off the wire.
  const filled: PhysicalRow = Object.assign(Object.create(null) as PhysicalRow, newTuple);
  let missing = 0;
  for (const name of unchanged) {
    if (relation.replicaIdentity === 'f' && oldTuple !== null && Object.hasOwn(oldTuple, name)) {
      const kept = oldTuple[name];
      if (kept !== undefined) filled[name] = kept;
    } else {
      missing += 1;
    }
  }
  const after = toRow(relation, filled, 'after');
  return {
    before,
    after,
    omitted: missing === 0 || after === null ? [] : omittedProperties(relation, after),
  };
}

/** A physical tuple becomes the row the matcher's predicates are written against, or nothing. */
function toRow(
  relation: PgRelation,
  physical: PhysicalRow | null,
  image: 'before' | 'after',
): Row | null {
  if (physical === null) return null;
  const row = entityRow(relation, physical, image);
  // A bigserial id decodes as a number inside `Number.isSafeInteger` range and as text outside it,
  // so the same table would otherwise identify small rows by number and large ones by string.
  // `Row.id`, `RowPatch.id` and every cursor are text: the identity is normalised once, here.
  const id = row['id'];
  if (typeof id === 'number' && Number.isSafeInteger(id)) row['id'] = String(id);
  if (isRow(row)) return row;
  throw new ReplicationProtocolError({
    stage: 'stream',
    detail: `table "${relation.name}" replicated a row with no text id column`,
    fix: `give ${relation.name} an id column, or drop it from the publication and the entity list`,
  });
}

/** The tenant, hoisted out of the row so fanout filters without parsing it. */
export const tenantOf = (row: Row | null): string | null => {
  const orgId = row?.['orgId'];
  return typeof orgId === 'string' ? orgId : null;
};
