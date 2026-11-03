// Single responsibility: what a patch or an upserted row writes beyond what the caller named — the
// `onUpdateNow()` stamp. Split from `query.ts` for its line ceiling.

import { entityNow } from './clock';
import type { EntityCore } from './entity';
import { namedColumns } from './plan';
import { copyRow } from './sealed';

/**
 * Columns declared `onUpdateNow()` are written by the framework, never by the caller. One helper,
 * so `update(id, patch)` and `updateWhere(filter, patch)` stamp the same columns at the same
 * moment — a second copy is how one of them ends up with a stale `updatedAt`.
 *
 * A patch that names nothing is returned untouched. Stamping `updatedAt` onto "the caller named no
 * columns" would turn that mistake into a real write on any entity that happens to declare the
 * column, and `X_PATCH_EMPTY` downstream would never see it — so whether the refusal fires would
 * depend on the schema rather than on the call.
 */
export const touch = <Row, Patch>(entity: EntityCore<Row>, patch: Patch): Patch => {
  if (namedColumns(patch).length === 0) return patch;
  const stamped: Record<string, unknown> = {};
  for (const [property, column] of Object.entries(entity.$columns)) {
    if (column.$meta.onUpdate !== undefined) stamped[property] = entityNow();
  }
  // `copyRow`, never `Object.assign({}, patch)`: a row passed back whole keeps its sealed properties.
  return Object.assign(copyRow(patch as object), stamped) as Patch;
};

/** The columns `touch` stamps: an upsert's collision moves them though no caller named them. */
export const stampedColumns = <Row>(entity: EntityCore<Row>): readonly string[] =>
  Object.entries(entity.$columns)
    .filter(([, column]) => column.$meta.onUpdate !== undefined)
    .map(([property]) => property);
