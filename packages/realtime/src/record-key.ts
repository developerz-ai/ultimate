// How a record is named in the page store: `type:key`, and the set of names an answer carried.
// Apart from the store so a module that only names records never loads the store's machinery.

import type { RecordRows, Row } from '@ultimat3/core/page';

/** `type:key`. A record type is an entity name, which never holds `:`, so the split is unambiguous. */
export type RecordKey = string;

export function recordKey(type: string, key: string): RecordKey {
  return `${type}:${key}`;
}

/**
 * Every record an answer's envelope names — adopted or removed — as `type:key`, added to `into`.
 * What an overlay settles against: a row the answer did not name keeps its overlay.
 */
export function carriedBy(
  envelope: {
    readonly records?: Readonly<Record<string, RecordRows>>;
    readonly removed?: Readonly<Record<string, readonly string[]>>;
  },
  into: Set<RecordKey>,
): void {
  for (const [type, rows] of Object.entries(envelope.records ?? {})) {
    for (const key of Object.keys(rows)) into.add(recordKey(type, key));
  }
  for (const [type, keys] of Object.entries(envelope.removed ?? {})) {
    for (const key of keys) into.add(recordKey(type, key));
  }
}

/** A row is a plain object: an array, `null` or a scalar off the wire is never merged. */
export const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
