// A row's record key: its primary-key columns rendered to one string, in DECLARED order, so the
// client store keys one record once whatever order a row's own properties arrived in. Runs in the
// browser too (the store keys adopted rows with it), so it imports nothing a page cannot carry.

import { isFixShellSafe, type Row, renderFixShellArg } from '@ultimat3/core';
import { describeValue } from '@ultimat3/schema';
import { EntityError } from './entity-error';

/**
 * A row reached a record key without one of its primary-key columns — a handler built the row by
 * hand, or a partial row was handed where a whole one was declared. Refused, never keyed as
 * `undefined`: two keyless rows would be ONE record in the store and overwrite each other.
 *
 * The value is described by SHAPE, never echoed: a key is the caller's data, and this cause
 * reaches the log line.
 */
export const recordKeyMissing = (type: string, column: string, value: unknown): EntityError =>
  new EntityError({
    code: 'X_RECORD_KEY_MISSING',
    cause: `a ${type} row reached its record key with primary-key column "${column}" holding ${describeValue(value)}, not a string, number, bigint, boolean or Date`,
    // Screened, never spliced: an entity NAME is only checked as an identifier when it is also the
    // table, so a declared name carrying shell syntax degrades to prose rather than a command. The
    // `renderFixShellArg` inside the safe branch is verbatim there; it is the call
    // `bun run fix-shell-arg` recognises as the screen.
    fix: isFixShellSafe(type)
      ? `x entities describe ${renderFixShellArg(type, 'ENTITY')} --json   # lists the primary key; return the whole row (every primary-key column) from the handler that built this one`
      : 'x entities list --json   # find this entity, then return the whole row (every primary-key column) from the handler that built this one',
  });

/** One part of a key. `Object.hasOwn`, never `row[column]` alone: an inherited member is no key. */
const partOf = (type: string, row: Row, column: string): string => {
  const value = Object.hasOwn(row, column) ? row[column] : undefined;
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      if (Number.isFinite(value)) return String(value);
      break;
    case 'bigint':
    case 'boolean':
      return String(value);
    default:
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  }
  throw recordKeyMissing(type, column, value);
};

/**
 * A single key is the value itself, so it is the same string `$tagFor(id)` and every realtime
 * topic already carry. A composite key percent-encodes each part before joining on `:`, so a part
 * holding the separator cannot make two different rows one key.
 */
export const recordKeyOf =
  (type: string, primaryKey: readonly string[]) =>
  (row: Row): string => {
    const [only, ...rest] = primaryKey;
    if (only !== undefined && rest.length === 0) return partOf(type, row, only);
    return primaryKey.map((column) => encodeURIComponent(partOf(type, row, column))).join(':');
  };
