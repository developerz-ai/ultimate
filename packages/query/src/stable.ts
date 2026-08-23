/**
 * How a column is read off a row that declares no index signature — one predicate the read path
 * needs everywhere, and one re-export beside it.
 *
 * Both halves used to be declared here and no longer are. `canonicalJson` and `fingerprint` are
 * `@ultimat3/core`'s, because `@ultimat3/action` and `@ultimat3/realtime` need the identical
 * function and all three are tier 3 — so a copy in any of them was a second answer for the other
 * two, and the copies had already diverged. This one rendered every `Date` as `{}`. `isJsonObject`
 * went the same way for the same reason, when `client-wire.ts` moved to tier 0.
 */

import { isJsonObject } from '@ultimat3/core';

/** Re-exported, not re-declared: `./stable` stays this package's one import path for it. */
export { isJsonObject };

/** Column read that works for interfaces without an index signature. */
export function columnOf(row: object, column: string): unknown {
  const record: unknown = row;
  return isJsonObject(record) ? record[column] : undefined;
}
