// The JSON value domain shared by the wire, the matcher, and the local store. This package now
// owns NO hash at all.
//
// `canonicalJson` and `stableDigest` USED to live here and are `@ultimat3/core`'s now: they were a
// third copy of one injective canonical form and one sharing-key hash, beside `@ultimat3/action`'s
// and `@ultimat3/query`'s, and the copies had already diverged. `fnv1a` stayed for one job — a
// cursor's result-set digest — and went with it (2026-08-24) when `LiveCursor.digest` was deleted
// for having no reader. A 32-bit hash nothing calls is a hash the next caller reaches for as a
// sharing key, which is the one thing it must never be.

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Every row that crosses the wire or lands in the local store is identified by `id`. */
export type Row = JsonObject & { id: string };

export type RowOp = 'insert' | 'update' | 'delete';

/**
 * The minimal delta for one row in one subscription's result set.
 * `index` is present only for ordered result sets, so a client can splice instead of re-sort.
 */
export interface RowPatch {
  readonly op: RowOp;
  readonly id: string;
  /** `null` for deletes. For updates this is the changed columns only, never the whole row. */
  readonly row: JsonObject | null;
  readonly lsn: string;
  readonly index?: number;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRow(value: unknown): value is Row {
  return isJsonObject(value) && typeof value['id'] === 'string';
}

/** Shallow diff used to keep update patches minimal — the pipeline never ships unchanged columns. */
export function changedColumns(before: JsonObject | null, after: JsonObject): JsonObject {
  if (before === null) return after;
  const out: JsonObject = {};
  for (const key of Object.keys(after)) {
    const next = after[key];
    if (next === undefined) continue;
    if (!sameJson(before[key], next)) out[key] = next;
  }
  return out;
}

function sameJson(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
