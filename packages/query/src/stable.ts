/**
 * What a JSON object IS to this package, and how a column is read off a row that declares no index
 * signature. Two small predicates the read path needs everywhere.
 *
 * The deterministic-JSON half used to live here and no longer does: `canonicalJson` and
 * `fingerprint` are `@ultimat3/core`'s, because `@ultimat3/action` and `@ultimat3/realtime` need
 * the identical function and all three are tier 3 — so a copy in any of them was a second answer
 * for the other two, and the copies had already diverged. This one rendered every `Date` as `{}`.
 */

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Column read that works for interfaces without an index signature. */
export function columnOf(row: object, column: string): unknown {
  const record: unknown = row;
  return isJsonObject(record) ? record[column] : undefined;
}
