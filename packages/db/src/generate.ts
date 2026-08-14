// Single responsibility: turn an entity snapshot into a timestamped, reversible migration.
// `db` is tier 2 and cannot import `@ultimat3/entity`, so the snapshot arrives as a parameter —
// the CLI passes `describeEntities()` and the types below mirror `EntityDescription` field for
// field. Every generated migration must be reversible; a drop that loses data refuses instead.

import { assert, systemClock } from '@ultimat3/core';
import { migrationIrreversible } from './errors';
import {
  type ColumnDescription,
  findTable,
  type SchemaDescription,
  type TableDescription,
} from './introspect';

/** Structurally assignment-compatible with `@ultimat3/entity`'s `ColumnDescription`. */
export interface ColumnDescriptionLike {
  readonly property: string;
  readonly column: string;
  readonly kind: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly hasDefault: boolean;
  readonly check: string | null;
  readonly references: string | null;
}

/**
 * Structurally assignment-compatible with `@ultimat3/entity`'s `IndexDescription`.
 *
 * The column list is carried, never recovered from `name`. Entity names an index
 * `<table>_<a>_<b>_idx`, and that convention does not run backwards: two columns joined by `_`
 * are one string, so a composite index read back out of its own name became the single column
 * `"org_id_created_at"` — DDL Postgres answers `42703` and a migration nobody can apply.
 */
export interface IndexDescriptionLike {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  /** Partial index predicate as SQL, `null` when the index covers every row. */
  readonly where: string | null;
  /** `null` is Postgres' own default (`asc`), never written out. */
  readonly order: 'asc' | 'desc' | null;
}

/** Structurally assignment-compatible with `@ultimat3/entity`'s `EntityDescription`. */
export interface EntityDescriptionLike {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly columns: readonly ColumnDescriptionLike[];
  readonly indexes: readonly IndexDescriptionLike[];
}

const SQL_TYPES: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  text: 'text',
  // Bare `char` is `char(1)` in Postgres, and the only column carrying this kind is money's
  // currency — a three-letter ISO 4217 code whose CHECK the entity emits on the same line.
  // Without the length no currency ever fits the constraint the same statement demands.
  char: 'char(3)',
  boolean: 'boolean',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  timestamptz: 'timestamptz',
  date: 'date',
  jsonb: 'jsonb',
};

function sqlType(kind: string): string {
  return SQL_TYPES[kind] ?? kind;
}

/**
 * Entity descriptions carry `hasDefault` but not the expression, so the two generated defaults
 * are inferred from the blessed column helpers. Anything else is left to a follow-up migration.
 */
function defaultExpression(column: ColumnDescriptionLike): string | null {
  if (!column.hasDefault) return null;
  if (column.kind === 'uuid' && column.primaryKey) return 'gen_random_uuid()';
  if (column.kind === 'timestamptz') return 'now()';
  return null;
}

function columnClause(column: ColumnDescriptionLike): string {
  const parts = [`"${column.column}"`, sqlType(column.kind)];
  const expression = defaultExpression(column);
  if (expression !== null) parts.push(`default ${expression}`);
  if (column.notNull) parts.push('not null');
  if (column.unique && !column.primaryKey) parts.push('unique');
  if (column.check !== null) parts.push(`check (${column.check})`);
  if (column.references !== null) {
    const [refTable = column.references, refColumn = 'id'] = column.references.split('.');
    parts.push(`references "${refTable}" ("${refColumn}")`);
  }
  return parts.join(' ');
}

/**
 * A `unique` column clause already creates an index, and Postgres names it exactly what the
 * entity's own convention names it — `<table>_<column>_key`. Emitting `create unique index` for
 * it too is the same index twice: `42P07`, and a migration that cannot be applied at all.
 * Mirrors the rule `entity()` already applies to a foreign key indexing its own column.
 *
 * A **partial** unique index is not that index: the column clause constrains every row, so
 * skipping the partial one would silently widen the constraint the entity declared.
 */
function impliedByColumnClause(
  entity: EntityDescriptionLike,
  index: IndexDescriptionLike,
  added: ReadonlySet<string>,
): boolean {
  const [only] = index.columns;
  if (!index.unique || index.where !== null || index.columns.length !== 1 || only === undefined) {
    return false;
  }
  const column = entity.columns.find((each) => each.column === only);
  // `columnClause` writes `unique` under exactly this condition — keep the two in step.
  //
  // NOT an optional chain, despite what biome's useOptionalChain suggests: `column?.unique` is
  // `boolean | undefined`, and this function returns `boolean`. The lint rule marks its own fix
  // unsafe for exactly this reason — applying it turned a green typecheck red.
  // biome-ignore lint/complexity/useOptionalChain: an optional chain widens the return to include undefined
  return column !== undefined && column.unique && !column.primaryKey && added.has(only);
}

export function snapshotOf(entities: readonly EntityDescriptionLike[]): SchemaDescription {
  const tables = [...entities]
    .sort((a, b) => (a.table < b.table ? -1 : 1))
    .map((entity): TableDescription => {
      const columns: ColumnDescription[] = [...entity.columns]
        .sort((a, b) => (a.column < b.column ? -1 : 1))
        .map((column, index) => ({
          name: column.column,
          dataType: sqlType(column.kind),
          nullable: !column.notNull,
          default: defaultExpression(column),
          position: index + 1,
        }));
      return {
        schema: 'public',
        name: entity.table,
        columns,
        primaryKey: [...entity.primaryKey],
        indexes: entity.indexes.map((index) => ({
          name: index.name,
          columns: index.columns,
          unique: index.unique,
          primary: false,
        })),
        foreignKeys: [],
      };
    });
  return { tables };
}

function createTable(entity: EntityDescriptionLike): readonly string[] {
  const clauses = entity.columns.map(columnClause);
  if (entity.primaryKey.length > 0) {
    clauses.push(`primary key (${entity.primaryKey.map((key) => `"${key}"`).join(', ')})`);
  }
  const statements = [`create table "${entity.table}" (\n  ${clauses.join(',\n  ')}\n);`];
  // Every column of a new table carries its own clause, so every `unique` one brings its index.
  const added = new Set(entity.columns.map((column) => column.column));
  for (const index of entity.indexes) {
    if (impliedByColumnClause(entity, index, added)) continue;
    statements.push(createIndex(entity.table, index));
  }
  return statements;
}

/**
 * Every part of the declaration reaches the statement: the whole column list in its declared
 * order, the direction when one was asked for, and the predicate that makes it partial. A part
 * dropped here is a constraint the database does not hold or an index the planner cannot use.
 */
function createIndex(table: string, index: IndexDescriptionLike): string {
  assert(
    index.columns.length > 0,
    `index "${index.name}" on "${table}" names no columns`,
    `indexes: [{ on: ['<column>'] }]   # name the columns in the entity(), then x db gen`,
  );
  const kind = index.unique ? 'create unique index' : 'create index';
  const direction = index.order === null ? '' : ` ${index.order}`;
  const columns = index.columns.map((column) => `"${column}"${direction}`).join(', ');
  const predicate = index.where === null ? '' : ` where (${index.where})`;
  return `${kind} "${index.name}" on "${table}" (${columns})${predicate};`;
}

interface Plan {
  readonly up: string[];
  readonly down: string[];
}

/**
 * Skipping an existing column by name alone missed the type moving under it: a table created
 * while money's currency was bare `char` keeps `char(1)` and rejects every ISO 4217 code, yet the
 * snapshot this run records claims `char(3)` — two claims with no statement between them. Both
 * sides are generated spellings (`current` is a previous migration's own snapshot), so any
 * difference is a real kind change, not a catalog alias.
 */
function retypeColumn(
  table: string,
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
  plan: Plan,
): void {
  const wanted = sqlType(column.kind);
  if (recorded.dataType === wanted) return;
  const alter = (type: string): string =>
    `alter table "${table}" alter column "${column.column}" type ${type} ` +
    `using "${column.column}"::${type};`;
  plan.up.push(alter(wanted));
  plan.down.push(alter(recorded.dataType));
}

function diffTable(entity: EntityDescriptionLike, live: TableDescription, plan: Plan): void {
  const existing = new Map(live.columns.map((column) => [column.name, column]));
  const added = new Set<string>();
  for (const column of entity.columns) {
    const recorded = existing.get(column.column);
    if (recorded !== undefined) {
      retypeColumn(entity.table, column, recorded, plan);
      continue;
    }
    added.add(column.column);
    // A NOT NULL add with no default cannot succeed on a populated table; emit it nullable and
    // leave the agent the exact follow-up rather than a migration that fails at 3am.
    const nullable = column.notNull && defaultExpression(column) === null;
    const clause = nullable ? columnClause({ ...column, notNull: false }) : columnClause(column);
    plan.up.push(`alter table "${entity.table}" add column ${clause};`);
    if (nullable) {
      plan.up.push(
        `-- backfill "${column.column}", then: ` +
          `alter table "${entity.table}" alter column "${column.column}" set not null;`,
      );
    }
    plan.down.push(`alter table "${entity.table}" drop column "${column.column}";`);
  }

  const indexed = new Set(live.indexes.map((index) => index.name));
  for (const index of entity.indexes) {
    if (indexed.has(index.name)) continue;
    // `added` only: an index over a column that was already there is implied by no clause this
    // migration emits, so it still needs a statement of its own.
    if (impliedByColumnClause(entity, index, added)) continue;
    plan.up.push(createIndex(entity.table, index));
    plan.down.push(`drop index "${index.name}";`);
  }
}

export interface GenerateOptions {
  readonly entities: readonly EntityDescriptionLike[];
  /** The schema migrations already declare — `expectedSchema(migrations, ledger)`. */
  readonly current?: SchemaDescription | undefined;
  readonly name: string;
  readonly now?: Date | undefined;
  /** Allow a DROP COLUMN whose down cannot restore the data. `x db gen --allow-destructive`. */
  readonly allowDestructive?: boolean | undefined;
}

export interface GeneratedMigration {
  readonly id: string;
  readonly name: string;
  readonly fileName: string;
  readonly up: string;
  readonly down: string;
  readonly snapshot: SchemaDescription;
}

export function migrationStamp(now: Date): string {
  return now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function generateMigration(options: GenerateOptions): GeneratedMigration {
  const current = options.current ?? { tables: [] };
  const plan: Plan = { up: [], down: [] };
  const wanted = new Set(options.entities.map((entity) => entity.table));

  for (const entity of options.entities) {
    const live = findTable(current, entity.table);
    if (live === undefined) {
      plan.up.push(...createTable(entity));
      plan.down.push(`drop table "${entity.table}";`);
      continue;
    }
    diffTable(entity, live, plan);
    const kept = new Set(entity.columns.map((column) => column.column));
    for (const column of live.columns) {
      if (kept.has(column.name)) continue;
      if (options.allowDestructive !== true) {
        throw migrationIrreversible(
          `dropping "${entity.table}"."${column.name}" discards its rows and cannot be undone`,
          `x db gen "${options.name}" --allow-destructive   # or keep the column and deprecate it`,
        );
      }
      plan.up.push(`alter table "${entity.table}" drop column "${column.name}";`);
      plan.down.push(
        `alter table "${entity.table}" add column "${column.name}" ${column.dataType};` +
          ' -- data is not restored',
      );
    }
  }

  for (const table of current.tables) {
    if (wanted.has(table.name)) continue;
    if (options.allowDestructive !== true) {
      throw migrationIrreversible(
        `dropping table "${table.name}" discards every row and cannot be undone`,
        `x db gen "${options.name}" --allow-destructive   # or delete the entity in two releases`,
      );
    }
    plan.up.push(`drop table "${table.name}";`);
    plan.down.push(`-- "${table.name}" cannot be restored; recover it from a backup`);
  }

  const id = `${migrationStamp(options.now ?? systemClock.now())}_${slugify(options.name)}`;
  return {
    id,
    name: options.name,
    fileName: `migrations/${id}.sql`,
    up: plan.up.join('\n'),
    // Reverse order: the last thing created is the first thing dropped.
    down: [...plan.down].reverse().join('\n'),
    snapshot: snapshotOf(options.entities),
  };
}
