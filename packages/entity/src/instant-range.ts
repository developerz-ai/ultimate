// Single responsibility: refuse, at a WRITE's entry, a `timestamp()` value Postgres cannot be
// handed. Never on read: an instant the server already holds — a sentinel a psql session wrote past
// year 9999 — still decodes, exactly as it did.

import { got } from './column-values';
import { instantCrosses } from './instant';
import { refuseColumn } from './refuse';
import type { AnyColumn } from './types';

const outOfRange = (value: unknown): boolean => value instanceof Date && !instantCrosses(value);

/**
 * A `Date` is bound as its ISO text, and outside years 0001–9999 the server refuses that text
 * (`22008`, `22007`, `22009`) while memory stored the row: one only a single driver could hold.
 * Refused by both, before either — the same place a malformed `uuid` is (`narrowUuid`). Only a
 * `Date` is judged: a repository write is asserted, not parsed, and `timestamp()`'s own parser has
 * made every other spelling a `Date` before a row reaches here.
 */
export const assertInstantsCross = (
  columns: Readonly<Record<string, AnyColumn>>,
  row: unknown,
): void => {
  if (typeof row !== 'object' || row === null) return;
  const record = row as Readonly<Record<string, unknown>>;
  for (const [property, column] of Object.entries(columns)) {
    const kind =
      column.$meta.kind === 'array' ? column.$meta.element?.$meta.kind : column.$meta.kind;
    if (kind !== 'timestamptz') continue;
    const value = record[property];
    const refusedValue = Array.isArray(value) ? value.find(outOfRange) : value;
    if (!outOfRange(refusedValue)) continue;
    refuseColumn(
      'format',
      `${property}: expected an instant in years 0001–9999, ${got(refusedValue)}`,
      "new Date('2026-03-14T09:00:00Z')   // timestamp() crosses to Postgres as ISO text with a four-digit year; store null on a .nullable() column for 'never', not a far-off sentinel",
    );
  }
};
