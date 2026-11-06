// Single responsibility: an entity's two row parsers — `$parse`, the whole row with declared
// defaults filled, and the wire parser `$schema` validates with, which neither requires nor copies a
// sealed column. Split from `entity.ts` at its line ceiling; both close over the same column list.

import { describeValue } from '@ultimat3/schema';
import { entityNow } from './clock';
import { newId } from './columns';
import { invariantViolated } from './errors';
import { sealedMissing } from './sealed-errors';
import type { AnyColumn, ColumnMeta } from './types';

const defaultValue = (meta: ColumnMeta): unknown => {
  const declared = meta.default;
  if (declared === undefined) return undefined;
  if (declared.kind === 'value') return declared.value;
  return declared.by === 'uuid-v7' ? newId() : entityNow();
};

export const rowParsers = <Row, Wire>(
  name: string,
  entries: readonly (readonly [string, AnyColumn])[],
  sealedKeys: ReadonlySet<string>,
): { readonly parse: (value: unknown) => Row; readonly parseWire: (value: unknown) => Wire } => {
  /** The columns that leave the server: every one that is not sealed. */
  const wireEntries = entries.filter(([property]) => !sealedKeys.has(property));

  const parse = (value: unknown): Row => {
    if (typeof value !== 'object' || value === null) {
      // `describeValue`, never `String(value)`: this message is a `$parse` failure, which reaches
      // the caller and the log line — and the whole row is the last value in the framework that
      // may be echoed there. Same renderer as the column builders (`columns.ts`) use.
      throw invariantViolated(name, 'row', `expected an object, got ${describeValue(value)}`);
    }
    const input = value as Readonly<Record<string, unknown>>;
    const row: Record<string, unknown> = {};
    for (const [property, column] of entries) {
      // `=== undefined`, never `??`: an explicit `null` is the caller CLEARING a nullable column,
      // and `??` read it as absence and wrote the column's declared default straight back — so
      // `update(id, { status: null })` reported success and stored `'draft'`, with nothing on any
      // surface to say otherwise. A present `undefined` still means absence, which is what a
      // spread of an omitted optional key produces and is the shape every existing caller has.
      const raw = input[property];
      const given = raw === undefined ? defaultValue(column.$meta) : raw;
      if (given === undefined || given === null) {
        if (column.$meta.notNull) {
          // A required sealed column ABSENT from a row is nearly always a spread of a repository
          // row, which does not enumerate it — so the refusal names that, and the rewrite.
          throw given === undefined && sealedKeys.has(property)
            ? sealedMissing(name, property)
            : invariantViolated(name, property, 'is required and has no default');
        }
        row[property] = null;
        continue;
      }
      row[property] = column.$parse(given);
    }
    // Every property was validated by its own column above, so the shape is the derived row.
    return row as Row;
  };

  /**
   * The row as `$schema` validates it: the sealed columns are neither required nor returned, so a
   * handler's row — which holds their plaintext — parses to a value that does not.
   */
  const parseWire = (value: unknown): Wire => {
    if (sealedKeys.size === 0) return parse(value) as unknown as Wire;
    if (typeof value !== 'object' || value === null) {
      throw invariantViolated(name, 'row', `expected an object, got ${describeValue(value)}`);
    }
    const input = value as Readonly<Record<string, unknown>>;
    const row: Record<string, unknown> = {};
    for (const [property, column] of wireEntries) {
      const raw = input[property];
      const given = raw === undefined ? defaultValue(column.$meta) : raw;
      if (given === undefined || given === null) {
        if (column.$meta.notNull) {
          throw invariantViolated(name, property, 'is required and has no default');
        }
        row[property] = null;
        continue;
      }
      row[property] = column.$parse(given);
    }
    // Every wire property was validated by its own column, and no sealed one was copied.
    return row as Wire;
  };

  return { parse, parseWire };
};
