// Single responsibility: turn the JSON of a `<id>.snapshot.json` sidecar into a `SchemaDescription`
// or into nothing. It lives beside the type it validates, because "what a valid snapshot is" is
// this package's answer and the reader on disk is `@ultimat3/cli`'s — two owners of that question
// is a sidecar one of them accepts and the other cannot use.

import type {
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  SchemaDescription,
  TableDescription,
} from './introspect';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): value is string => typeof value === 'string';
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const nullableStr = (value: unknown): value is string | null => value === null || str(value);
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(str);

/** `null` is Postgres' own default; anything else must be one of the two directions. */
const order = (value: unknown): value is 'asc' | 'desc' | null =>
  value === null || value === 'asc' || value === 'desc';

function column(value: unknown): ColumnDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, dataType, nullable, default: fallback, position } = value;
  if (!str(name) || !str(dataType) || !bool(nullable) || !nullableStr(fallback)) return undefined;
  if (typeof position !== 'number') return undefined;
  return { name, dataType, nullable, default: fallback, position };
}

function index(value: unknown): IndexDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, columns, unique, primary, where, order: direction } = value;
  if (!str(name) || !strings(columns) || !bool(unique) || !bool(primary)) return undefined;
  // Written by 1.2.0 onwards. A sidecar from before it carries neither, and the total, ascending
  // reading is what that generation actually emitted — so an older file stays readable rather
  // than being discarded whole, which would refuse to generate against every existing app.
  if (!(where === undefined || nullableStr(where))) return undefined;
  if (!(direction === undefined || order(direction))) return undefined;
  return {
    name,
    columns,
    unique,
    primary,
    where: where === undefined ? null : where,
    order: direction === undefined ? null : direction,
  };
}

function foreignKey(value: unknown): ForeignKeyDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, columns, referencedTable, referencedColumns, onDelete } = value;
  if (!str(name) || !strings(columns) || !str(referencedTable)) return undefined;
  if (!strings(referencedColumns) || !nullableStr(onDelete)) return undefined;
  return { name, columns, referencedTable, referencedColumns, onDelete };
}

/** `undefined` from any member rejects the whole list — a partial table is not a smaller one. */
function all<T>(value: unknown, one: (item: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed: T[] = [];
  for (const item of value) {
    const each = one(item);
    if (each === undefined) return undefined;
    parsed.push(each);
  }
  return parsed;
}

function tableOf(value: unknown): TableDescription | undefined {
  if (!isRow(value)) return undefined;
  const { schema, name, primaryKey } = value;
  if (!str(schema) || !str(name) || !strings(primaryKey)) return undefined;
  const columns = all(value['columns'], column);
  const indexes = all(value['indexes'], index);
  const foreignKeys = all(value['foreignKeys'], foreignKey);
  if (columns === undefined || indexes === undefined || foreignKeys === undefined) return undefined;
  return { schema, name, columns, primaryKey, indexes, foreignKeys };
}

/**
 * The snapshot `value` describes, or `undefined` if it describes anything else.
 *
 * Every nested field is parsed, not asserted: `{"tables":[null]}` is syntactically valid JSON that
 * an `Array.isArray(tables)` check accepted and a cast then called a `SchemaDescription`, so the
 * first `table.columns` in the diff threw on a truncated or hand-edited sidecar rather than
 * regenerating it. A file that will not parse is *absent* — which the caller already handles.
 */
export function parseSnapshot(value: unknown): SchemaDescription | undefined {
  if (!isRow(value)) return undefined;
  const tables = all(value['tables'], tableOf);
  return tables === undefined ? undefined : { tables };
}
