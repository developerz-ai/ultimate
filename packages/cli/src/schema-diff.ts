// Single responsibility: what two GENERATED schema snapshots disagree about, as data. One side is
// `snapshotOf(describeEntities())` — what the app declares right now — and the other is the
// `.snapshot.json` the newest migration wrote down.
//
// Not `@ultimat3/db`'s `diffSchema`, and it never can be: that one compares a LIVE catalog to a
// snapshot, so a predicate, a type name and a default are the server's own rewriting and are
// deliberately left uncompared. Here both sides come out of `snapshotOf`, which is what makes a
// check, a default and a column type comparable at all — and those are exactly the three the
// `drift` gate step could not see.

import type {
  CheckDescription,
  ColumnDescription,
  ForeignKeyDescription,
  IndexDescription,
  SchemaDescription,
  TableDescription,
} from '@ultimat3/db';
import { indexMethodOf } from '@ultimat3/db';

/**
 * Which side holds a declaration the other does not, and they are two different repairs.
 * `unmigrated` means the app declares it and no migration carries it, so no database will ever
 * get it. `undeclared` means a migration recorded it and nothing in source declares it any more.
 */
export type SchemaDirection = 'unmigrated' | 'undeclared';

/** The part of a table a difference is about. Rendered into the cause verbatim. */
export type SchemaPart = 'table' | 'column' | 'index' | 'foreign key' | 'check';

export interface SchemaDifference {
  readonly direction: SchemaDirection;
  readonly part: SchemaPart;
  readonly table: string;
  /** The column, index, constraint or table name. */
  readonly name: string;
  /** One line naming what differs — it reaches a `cause:`, so it never spans lines. */
  readonly detail: string;
}

const DECLARED_ONLY = 'is declared by the entities and no migration recorded it';
const RECORDED_ONLY = 'was recorded by the newest migration and no entity declares it';

const columns = (names: readonly string[]): string => names.join(', ');

/** A default is SQL or nothing at all, and "nothing" has to read as a value in the sentence. */
const defaultSql = (value: string | null): string => (value === null ? 'no default' : value);

function columnDetail(
  declared: ColumnDescription,
  recorded: ColumnDescription,
): string | undefined {
  if (declared.dataType !== recorded.dataType) {
    return `is declared ${declared.dataType} and was recorded ${recorded.dataType}`;
  }
  if (declared.nullable !== recorded.nullable) {
    return declared.nullable
      ? 'is declared nullable and was recorded not null'
      : 'is declared not null and was recorded nullable';
  }
  if (declared.default !== recorded.default) {
    return `is declared ${defaultSql(declared.default)} and was recorded ${defaultSql(recorded.default)}`;
  }
  // Absent and absent agree; absent against an expression is a column the database computes on one
  // side and a writer supplies on the other, which is a `23502` on the first insert.
  if ((declared.generated ?? null) !== (recorded.generated ?? null)) {
    return `is declared generated as ${declared.generated ?? 'nothing'} and was recorded ${
      recorded.generated ?? 'not generated'
    }`;
  }
  return undefined;
}

/**
 * Absent `using` is `btree` and absent `order` is `asc` — both are Postgres' own defaults and what
 * every index recorded before those fields existed is. Read literally, every app with a sidecar
 * from before them would report a difference on every index it has.
 */
function indexDetail(declared: IndexDescription, recorded: IndexDescription): string | undefined {
  if (columns(declared.columns) !== columns(recorded.columns)) {
    return `is declared over (${columns(declared.columns)}) and was recorded over (${columns(recorded.columns)})`;
  }
  if (declared.unique !== recorded.unique) {
    return declared.unique
      ? 'is declared unique and was recorded non-unique'
      : 'is declared non-unique and was recorded unique';
  }
  if (indexMethodOf(declared) !== indexMethodOf(recorded)) {
    return `is declared ${indexMethodOf(declared)} and was recorded ${indexMethodOf(recorded)}`;
  }
  if ((declared.order ?? 'asc') !== (recorded.order ?? 'asc')) {
    return `is declared ${declared.order ?? 'asc'} and was recorded ${recorded.order ?? 'asc'}`;
  }
  if (declared.where !== recorded.where) {
    return `is declared ${declared.where === null ? 'over every row' : `where ${declared.where}`} and was recorded ${
      recorded.where === null ? 'over every row' : `where ${recorded.where}`
    }`;
  }
  return undefined;
}

function keyDetail(
  declared: ForeignKeyDescription,
  recorded: ForeignKeyDescription,
): string | undefined {
  const target = (key: ForeignKeyDescription): string =>
    `(${columns(key.columns)}) -> "${key.referencedTable}" (${columns(key.referencedColumns)})`;
  if (target(declared) !== target(recorded)) {
    return `is declared ${target(declared)} and was recorded ${target(recorded)}`;
  }
  // `null` is "no rule declared", which Postgres records as `no action` — a real answer, and the
  // difference between an orphan row and a cascading delete.
  if (declared.onDelete !== recorded.onDelete) {
    return `is declared on delete ${declared.onDelete ?? 'unset'} and was recorded on delete ${
      recorded.onDelete ?? 'unset'
    }`;
  }
  return undefined;
}

const checkDetail = (declared: CheckDescription, recorded: CheckDescription): string | undefined =>
  declared.expression === recorded.expression
    ? undefined
    : `is declared "${declared.expression}" and was recorded "${recorded.expression}"`;

interface ListComparison<T> {
  readonly part: SchemaPart;
  readonly table: string;
  readonly declared: readonly T[];
  readonly recorded: readonly T[];
  readonly key: (item: T) => string;
  /** What differs between two items of the same name, or `undefined` when they agree. */
  readonly detail: (declared: T, recorded: T) => string | undefined;
}

/**
 * Both directions of one named list, in one pass. A `Map` and not an object literal: a constraint
 * name is data, and a computed read of a `Record<…>` answers an `Object.prototype` member for a
 * table someone called `constructor`.
 *
 * A CHANGED item is reported as `unmigrated`, never as its own direction: the declaration is the
 * intent and a migration that recorded something else is the one that is behind.
 */
function compareList<T>(comparison: ListComparison<T>): SchemaDifference[] {
  const { part, table } = comparison;
  const out: SchemaDifference[] = [];
  const recorded = new Map(comparison.recorded.map((item) => [comparison.key(item), item]));
  for (const item of comparison.declared) {
    const name = comparison.key(item);
    const counterpart = recorded.get(name);
    if (counterpart === undefined) {
      out.push({ direction: 'unmigrated', part, table, name, detail: DECLARED_ONLY });
      continue;
    }
    const detail = comparison.detail(item, counterpart);
    if (detail !== undefined) out.push({ direction: 'unmigrated', part, table, name, detail });
  }
  const declared = new Set(comparison.declared.map(comparison.key));
  for (const item of comparison.recorded) {
    const name = comparison.key(item);
    if (declared.has(name)) continue;
    out.push({ direction: 'undeclared', part, table, name, detail: RECORDED_ONLY });
  }
  return out;
}

/**
 * `checks` is absent — never `[]` — on a table that declares none, deliberately, so a sidecar
 * written before the field existed reads as "nothing recorded" rather than "recorded none". Both
 * sides normalise to empty here for the same reason: a table that never had a constraint must not
 * report one, and a table that has nine of them must.
 */
function compareTable(declared: TableDescription, recorded: TableDescription): SchemaDifference[] {
  const table = declared.name;
  const out: SchemaDifference[] = [];
  // Read into locals first, and NOT named `…Key`: `bun run secret-compare` matches an operand
  // whose NAME says it holds a credential, and a row's identity is the opposite of a secret — it
  // is in every URL the app serves.
  const declaredIdentity = columns(declared.primaryKey);
  const recordedIdentity = columns(recorded.primaryKey);
  if (declaredIdentity !== recordedIdentity) {
    out.push({
      direction: 'unmigrated',
      part: 'table',
      table,
      name: table,
      detail: `declares primary key (${columns(declared.primaryKey)}) and the migration recorded (${columns(recorded.primaryKey)})`,
    });
  }
  out.push(
    ...compareList({
      part: 'column',
      table,
      declared: declared.columns,
      recorded: recorded.columns,
      key: (column) => column.name,
      detail: columnDetail,
    }),
    ...compareList({
      part: 'index',
      table,
      declared: declared.indexes,
      recorded: recorded.indexes,
      key: (index) => index.name,
      detail: indexDetail,
    }),
    ...compareList({
      part: 'foreign key',
      table,
      declared: declared.foreignKeys,
      recorded: recorded.foreignKeys,
      key: (key) => key.name,
      detail: keyDetail,
    }),
    ...compareList({
      part: 'check',
      table,
      declared: declared.checks ?? [],
      recorded: recorded.checks ?? [],
      key: (check) => check.name,
      detail: checkDetail,
    }),
  );
  return out;
}

const PART_ORDER: readonly SchemaPart[] = ['table', 'column', 'index', 'foreign key', 'check'];

/**
 * Pure and total: the same two snapshots always produce the same ordered report, so a diff of two
 * gate runs on two machines is readable.
 *
 * A table present on only one side is ONE difference and the columns under it are not descended
 * into — the repair is a single statement, and a finding per column would be twelve instructions
 * for it.
 */
export function diffDeclaredSchema(
  declared: SchemaDescription,
  recorded: SchemaDescription,
): readonly SchemaDifference[] {
  const out: SchemaDifference[] = [];
  const byName = new Map(recorded.tables.map((table) => [table.name, table]));
  for (const table of declared.tables) {
    const counterpart = byName.get(table.name);
    if (counterpart === undefined) {
      out.push({
        direction: 'unmigrated',
        part: 'table',
        table: table.name,
        name: table.name,
        detail: DECLARED_ONLY,
      });
      continue;
    }
    out.push(...compareTable(table, counterpart));
  }
  const declaredTables = new Set(declared.tables.map((table) => table.name));
  for (const table of recorded.tables) {
    if (declaredTables.has(table.name)) continue;
    out.push({
      direction: 'undeclared',
      part: 'table',
      table: table.name,
      name: table.name,
      detail: RECORDED_ONLY,
    });
  }
  out.sort((a, b) => {
    if (a.table !== b.table) return a.table < b.table ? -1 : 1;
    if (a.part !== b.part) return PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part);
    if (a.direction !== b.direction) return a.direction < b.direction ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}
