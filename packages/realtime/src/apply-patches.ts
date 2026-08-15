// One job: fold a patch list onto a result set. Pure and outside `LiveClient` because it is the only
// piece of the client with no socket, no signal and no state — which is what makes it the piece an
// app can reuse to apply the same patches to its own store.
//
// Order and values are folded separately: a live window keeps its ORDER here and its VALUES in the
// identity map, so `applyPatches` is the array form of the same fold rather than a second one.

import type { JsonObject, Row, RowPatch } from './json';

/**
 * Membership and order after a patch list, ids only. `index` places a row the set does not hold
 * yet; a row it already holds keeps its position, because a patch reorders nothing it did not say
 * to reorder.
 */
export function orderAfterPatches(
  ids: readonly string[],
  patches: readonly RowPatch[],
): readonly string[] {
  let next = ids;
  for (const patch of patches) {
    if (patch.op === 'delete') {
      next = next.filter((id) => id !== patch.id);
      continue;
    }
    if (patch.row === null) continue;
    if (next.includes(patch.id)) continue;
    if (patch.index !== undefined) {
      const copy = [...next];
      copy.splice(patch.index, 0, patch.id);
      next = copy;
      continue;
    }
    next = [...next, patch.id];
  }
  return next;
}

/** Minimal in-place patch application: the shape a Solid store update maps onto directly. */
export function applyPatches(rows: readonly Row[], patches: readonly RowPatch[]): readonly Row[] {
  const values = new Map<string, Row>(rows.map((row) => [row.id, row]));
  for (const patch of patches) {
    if (patch.op === 'delete' || patch.row === null) continue;
    values.set(patch.id, mergeRow(values.get(patch.id), patch.id, patch.row));
  }
  const out: Row[] = [];
  for (const id of orderAfterPatches(
    rows.map((row) => row.id),
    patches,
  )) {
    const row = values.get(id);
    if (row !== undefined) out.push(row);
  }
  return out;
}

/** The one merge rule: changed columns over the current value, and `id` is never overwritten. */
function mergeRow(current: Row | undefined, id: string, columns: JsonObject): Row {
  const next: JsonObject = { ...(current ?? {}), ...columns };
  return { ...next, id };
}
