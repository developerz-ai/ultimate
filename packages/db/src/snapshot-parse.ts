// Single responsibility: turn the JSON of a `<id>.snapshot.json` sidecar into a `SchemaDescription`
// or into nothing. It lives beside the type it validates, because "what a valid snapshot is" is
// this package's answer and the reader on disk is `@ultimat3/cli`'s — two owners of that question
// is a sidecar one of them accepts and the other cannot use.

import { PARTITION_INTERVALS, type PartitionInterval } from './entity-shape';
import type {
  CheckDescription,
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  SchemaDescription,
  TableDescription,
  TriggerRecord,
  ViewDescription,
} from './introspect';

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): value is string => typeof value === 'string';
const bool = (value: unknown): value is boolean => typeof value === 'boolean';
const nullableStr = (value: unknown): value is string | null => value === null || str(value);
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(str);

const INTERVALS: readonly unknown[] = PARTITION_INTERVALS;
const interval = (value: unknown): value is PartitionInterval => INTERVALS.includes(value);

/** `null` is Postgres' own default; anything else must be one of the two directions. */
const order = (value: unknown): value is 'asc' | 'desc' | null =>
  value === null || value === 'asc' || value === 'desc';

/** One direction per key, each of the closed set. */
const directions = (value: unknown): value is readonly ('asc' | 'desc' | null)[] =>
  Array.isArray(value) && value.every(order);

function column(value: unknown): ColumnDescription | undefined {
  if (!isRow(value)) return undefined;
  const {
    name,
    dataType,
    nullable,
    default: fallback,
    position,
    generated,
    retired,
    collation,
  } = value;
  if (!str(name) || !str(dataType) || !bool(nullable) || !nullableStr(fallback)) return undefined;
  if (typeof position !== 'number') return undefined;
  // `generated` was recorded by `snapshotOf` and dropped HERE, silently, for as long as the field
  // has existed: the sidecar carried the expression and the parse handed back a column without it,
  // so `retypeColumn` read every generated column as newly generated and rebuilt it on every
  // `x db gen`. Absent stays absent — an ordinary column must gain no key.
  if (!(generated === undefined || str(generated))) return undefined;
  // The same rule for a collation: dropped here, every `x db gen` would declare it again.
  if (!(collation === undefined || str(collation))) return undefined;
  // Dropped here it would refuse the drop it exists to allow. `true` or nothing, `false` normalised
  // away: a hand-edit meaning what absence means, the rule `appendOnly` states below.
  if (!(retired === undefined || bool(retired))) return undefined;
  return {
    name,
    dataType,
    nullable,
    default: fallback,
    position,
    ...(generated === undefined ? {} : { generated }),
    ...(collation === undefined ? {} : { collation }),
    ...(retired === true ? { retired: true as const } : {}),
  };
}

/** The predicate is the snapshot's own spelling, so both halves are plain strings or nothing. */
function check(value: unknown): CheckDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, expression } = value;
  if (!str(name) || !str(expression)) return undefined;
  return { name, expression };
}

function index(value: unknown): IndexDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, columns, unique, primary, where, order: direction, using } = value;
  const { expression, orders, include, operatorClass } = value;
  if (!str(name) || !strings(columns) || !bool(unique) || !bool(primary)) return undefined;
  // Written by 1.2.0 onwards. A sidecar from before it carries neither, and the total, ascending
  // reading is what that generation actually emitted — so an older file stays readable rather
  // than being discarded whole, which would refuse to generate against every existing app.
  if (!(where === undefined || nullableStr(where))) return undefined;
  if (!(direction === undefined || order(direction))) return undefined;
  // Any string, not the closed set. The live side of this type is the CATALOG's, which answers
  // `gist` and an extension's own access method, and a sidecar recording one must round-trip so
  // drift can report it — the refusal belongs at generation, where `declaredMethod` names the
  // method and the fix, not here, where it would discard the whole snapshot without saying which
  // field was wrong. Absent stays absent: `indexMethodOf` reads it as the btree it always was.
  if (!(using === undefined || str(using))) return undefined;
  // The four key parts: each absent or well-formed, never dropped. Dropped here, `indexShape` read
  // the recorded index as the plain one and every `x db gen` rebuilt it — `generated`'s old hole.
  if (!(expression === undefined || str(expression))) return undefined;
  if (!(orders === undefined || directions(orders))) return undefined;
  if (!(include === undefined || strings(include))) return undefined;
  if (!(operatorClass === undefined || str(operatorClass))) return undefined;
  return {
    name,
    columns,
    unique,
    primary,
    where: where === undefined ? null : where,
    order: direction === undefined ? null : direction,
    ...(using === undefined ? {} : { using }),
    ...(expression === undefined ? {} : { expression }),
    ...(orders === undefined ? {} : { orders }),
    ...(include === undefined ? {} : { include }),
    ...(operatorClass === undefined ? {} : { operatorClass }),
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

function trigger(value: unknown): TriggerRecord | undefined {
  if (!isRow(value)) return undefined;
  const { name, install } = value;
  return str(name) && strings(install) ? { name, install } : undefined;
}

function tableOf(value: unknown): TableDescription | undefined {
  if (!isRow(value)) return undefined;
  const { schema, name, primaryKey } = value;
  if (!str(schema) || !str(name) || !strings(primaryKey)) return undefined;
  const columns = all(value['columns'], column);
  const indexes = all(value['indexes'], index);
  const foreignKeys = all(value['foreignKeys'], foreignKey);
  if (columns === undefined || indexes === undefined || foreignKeys === undefined) return undefined;
  // Absent, never `[]`. A sidecar written before constraints were recorded says nothing about
  // them, and reading that as "this table declares none" would drop every invariant an app has
  // already generated instead of adding the ones its database is missing.
  // `true` or nothing. `false` is accepted and NORMALISED away rather than rejecting the file: it
  // is a hand-edit meaning exactly what absence means, and discarding the whole snapshot over it
  // makes `x db gen` refuse with `X_MIGRATION_SNAPSHOT_MISSING` on a sidecar that says nothing
  // wrong. Any other value is garbage and takes the file with it, like every field above.
  const identity = value['replicaIdentityFull'];
  if (!(identity === undefined || bool(identity))) return undefined;
  // `appendOnly` by the same rule: `true` or nothing, `false` normalised away.
  const appendOnly = value['appendOnly'];
  if (!(appendOnly === undefined || bool(appendOnly))) return undefined;
  // `rowSecurity` by the same rule once more.
  const rowSecurity = value['rowSecurity'];
  if (!(rowSecurity === undefined || bool(rowSecurity))) return undefined;
  const retain = value['retain'];
  if (!(retain === undefined || bool(retain))) return undefined;
  // `partitioned` by the same rule; its interval absent, or one of the set — the record
  // `partitionPlan` refuses a removal and a change of width against.
  const partitioned = value['partitioned'];
  if (!(partitioned === undefined || bool(partitioned))) return undefined;
  const width = value['partitionInterval'];
  if (!(width === undefined || interval(width))) return undefined;
  // Absent is none recorded; anything present must be a list of `{ name, install }`.
  const rawTriggers = value['triggers'];
  const triggers = rawTriggers === undefined ? undefined : all(rawTriggers, trigger);
  if (rawTriggers !== undefined && triggers === undefined) return undefined;
  const flags = {
    ...(retain === true ? { retain: true as const } : {}),
    ...(triggers === undefined ? {} : { triggers }),
    ...(identity === true ? { replicaIdentityFull: true as const } : {}),
    ...(appendOnly === true ? { appendOnly: true as const } : {}),
    ...(rowSecurity === true ? { rowSecurity: true as const } : {}),
    ...(partitioned === true ? { partitioned: true as const } : {}),
    ...(width === undefined ? {} : { partitionInterval: width }),
  };
  const raw = value['checks'];
  if (raw === undefined) {
    return { schema, name, columns, primaryKey, indexes, foreignKeys, ...flags };
  }
  const checks = all(raw, check);
  if (checks === undefined) return undefined;
  return { schema, name, columns, primaryKey, indexes, foreignKeys, checks, ...flags };
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
  if (tables === undefined) return undefined;
  const recorded = value['views'];
  if (recorded === undefined) return { tables };
  const views = all(recorded, viewOf);
  return views === undefined ? undefined : { tables, views };
}

/** One recorded view: a name, the flag, the statements — anything else is not a snapshot. */
function viewOf(value: unknown): ViewDescription | undefined {
  if (!isRow(value)) return undefined;
  const { name, materialized, create } = value;
  if (typeof name !== 'string') return undefined;
  if (!(materialized === undefined || materialized === true)) return undefined;
  if (!Array.isArray(create) || !create.every((each) => typeof each === 'string')) {
    return undefined;
  }
  return { name, ...(materialized === true ? { materialized } : {}), create };
}
