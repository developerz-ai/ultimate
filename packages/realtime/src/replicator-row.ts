// Single responsibility: a change's rows across the replicator bus. The bus carries text, a row
// holds a `Date` and a `Uint8Array`, and `JSON.parse` returns neither — so the publisher writes a
// form JSON can carry and the sync node reads it back through the ENTITY's own columns.

import { entityForTable } from '@ultimat3/entity';
import type { Row } from './json';

const CHUNK = 0x8000;

/** Base64 of raw bytes. Chunked: one `String.fromCharCode(...bytes)` overflows the stack at ~100k. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

/**
 * Publish side. A `Date` already serialises to the ISO text its column reads back; a `Uint8Array`
 * serialises to `{"0":1,"1":2}`, which nothing reads back, so it crosses as base64. Only a
 * top-level value can be one: `arrayOf()` refuses `bytes()` at declaration.
 */
export function busRow(row: Row | null): Row | null {
  if (row === null) return null;
  let out: Record<string, unknown> | undefined;
  for (const [property, value] of Object.entries(row as Record<string, unknown>)) {
    if (!(value instanceof Uint8Array)) continue;
    out ??= { ...row };
    out[property] = toBase64(value);
  }
  return out === undefined ? row : (out as unknown as Row);
}

/**
 * Consume side: the row as the replicator held it before it was text. Without this every `Date`
 * reached the matcher as an ISO string, `compareValues(Date, string)` fell to comparing their
 * printed forms, and one edit to one column moved its row to the top of every window ordered by
 * a timestamp — on every deployment with a bus, and in no in-process test, which hands the object
 * over directly.
 *
 * Decided by the column that DECLARED the value, never by what the value looks like: a `text()`
 * holding `2026-08-09T12:00:00.000Z` stays text. `table` is `ChangeEvent.entity`, which on the WAL
 * path is the relation name. A table with no entity here, a property with no column, and a value
 * its column refuses are all handed back as they arrived — a change that crosses unrevived is the
 * old behaviour; a change dropped is a window that silently diverges.
 */
export function reviveBusRow(table: string, row: Row | null): Row | null {
  if (row === null) return null;
  const entity = entityForTable(table);
  if (entity === undefined) return row;
  const out: Record<string, unknown> = {};
  for (const [property, value] of Object.entries(row as Record<string, unknown>)) {
    out[property] = value;
    if (value === null || !Object.hasOwn(entity.$columns, property)) continue;
    const column = entity.$columns[property];
    if (column === undefined || column.$meta.sealed !== undefined) continue;
    try {
      out[property] =
        column.$meta.kind === 'bytea' && typeof value === 'string'
          ? fromBase64(value)
          : column.$parse(value);
    } catch {
      // Kept as it arrived — see the function comment.
    }
  }
  return out as unknown as Row;
}
