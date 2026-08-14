// One job: fold a patch list onto a row list. Pure and outside `LiveClient` because it is the only
// piece of the client with no socket, no signal and no state — which is what makes it the piece an
// app can reuse to apply the same patches to its own store.

import type { Row, RowPatch } from './json';

/** Minimal in-place patch application: the shape a Solid store update maps onto directly. */
export function applyPatches(rows: readonly Row[], patches: readonly RowPatch[]): readonly Row[] {
  let next = rows;
  for (const patch of patches) {
    if (patch.op === 'delete') {
      next = next.filter((row) => row.id !== patch.id);
      continue;
    }
    if (patch.row === null) continue;
    const index = next.findIndex((row) => row.id === patch.id);
    const current = index >= 0 ? next[index] : undefined;
    const merged: Row = { ...(current ?? {}), ...patch.row, id: patch.id };
    if (index >= 0) {
      const copy = [...next];
      copy[index] = merged;
      next = copy;
    } else if (patch.index !== undefined) {
      const copy = [...next];
      copy.splice(patch.index, 0, merged);
      next = copy;
    } else {
      next = [...next, merged];
    }
  }
  return next;
}
