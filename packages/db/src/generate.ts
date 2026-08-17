// Single responsibility: turn an entity snapshot into a timestamped, reversible migration.
// `db` is tier 1 and cannot import `@ultimat3/entity`, so the snapshot arrives as a parameter —
// the CLI passes `describeEntities()` and the types below mirror `EntityDescription` field for
// field. Every generated migration must be reversible; a drop that loses data refuses instead.

import { assert, systemClock } from '@ultimat3/core';
import { isDestructive } from './destructive';
import { migrationIrreversible } from './errors';
import { addForeignKey, dropForeignKey, foreignKeyTarget } from './foreign-key';
import {
  type ColumnDescription,
  type ForeignKeyDescription,
  findTable,
  type IndexDescription,
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

/**
 * The two ends of a `references()`, which entity renders as `"<table>.<column>"`. Read once: the
 * clause that writes the constraint and the snapshot that records it must not disagree about what
 * it points at, or drift reports a key the database holds exactly as declared.
 */
function referenceParts(references: string): readonly [string, string] {
  const [table = references, column = 'id'] = references.split('.');
  return [table, column];
}

function columnClause(column: ColumnDescriptionLike): string {
  const parts = [`"${column.column}"`, sqlType(column.kind)];
  const expression = defaultExpression(column);
  if (expression !== null) parts.push(`default ${expression}`);
  if (column.notNull) parts.push('not null');
  if (column.unique && !column.primaryKey) parts.push('unique');
  if (column.check !== null) parts.push(`check (${column.check})`);
  // No `references` clause. A foreign key is `alter table … add constraint`, emitted after every
  // table exists (`foreignKeyPlan`) — inline it must point at a table that already exists, and
  // entity registration order is the app's import order, which says nothing about that.
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

/**
 * The keys this entity declares, recorded so drift can see one dropped by hand. Recording
 * `foreignKeys: []` while the same run emitted a constraint was a snapshot claiming a constraint
 * does not exist that the migration beside it creates, and `compareTable` had nothing to compare —
 * a key dropped on the database was invisible to every check the framework runs.
 *
 * The name is `<table>_<column>_fkey` — what Postgres would have called an inline `references`
 * clause — and `addForeignKey` now writes it out, so the snapshot records a name the migration
 * beside it chose rather than one it guessed. It is still *not* what drift matches on: see
 * `compareForeignKeys` in `drift.ts`.
 *
 * `onDelete` stays `null`. `entity()` carries the option and no clause here has ever spelled one,
 * so a value written down would be a claim about the database that is not true.
 */
function foreignKeysOf(entity: EntityDescriptionLike): ForeignKeyDescription[] {
  return entity.columns
    .filter((column) => column.references !== null)
    .map((column): ForeignKeyDescription => {
      const [table, key] = referenceParts(column.references ?? '');
      return {
        name: `${entity.table}_${column.column}_fkey`,
        columns: [column.column],
        referencedTable: table,
        referencedColumns: [key],
        onDelete: null,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
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
        // Whole, never partly: a snapshot that recorded the name and dropped the predicate made
        // the next generation blind to a `where` or an `order` changing, and a partial index
        // silently kept as a total one is a constraint the entity no longer declares.
        indexes: entity.indexes.map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          primary: false,
          where: index.where,
          order: index.order,
        })),
        foreignKeys: foreignKeysOf(entity),
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
 * Every foreign key the entity declares that the previous snapshot does not already record, as its
 * own `add constraint`. One call site for both cases the generator has — a table being created and
 * a `references()` added to a column that already exists — because they are one question: which of
 * this entity's keys does the database not hold yet.
 *
 * The statements land in a bucket of their own, appended after every table statement, so a key
 * never runs before the table it points at. `down` is reversed as a whole, so pushing the drops
 * last here puts them *first* on the way back: `drop table "posts"` with `comments` still
 * referencing it is `2BP01`, a migration that cannot be rolled back at all.
 */
function foreignKeyPlan(
  entity: EntityDescriptionLike,
  live: TableDescription | undefined,
  constraints: Plan,
): void {
  const held = new Set((live?.foreignKeys ?? []).map(foreignKeyTarget));
  for (const key of foreignKeysOf(entity)) {
    if (held.has(foreignKeyTarget(key))) continue;
    constraints.up.push(addForeignKey(entity.table, key));
    constraints.down.push(dropForeignKey(entity.table, key.name));
  }
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

/** The parts of an index Postgres cannot alter in place — every one of them is a rebuild. */
function indexShape(index: IndexDescriptionLike | IndexDescription): string {
  return JSON.stringify([[...index.columns], index.unique, index.where, index.order ?? null]);
}

/**
 * A same-named index whose definition moved is dropped and recreated, because Postgres has no
 * `alter index` for any of it — the column list, the uniqueness, the predicate and the direction
 * are all fixed at creation.
 *
 * Matching on the name alone was the gap: `where` and `order` were not even recorded, so an
 * entity narrowing an index to a predicate, or reversing it to `desc`, generated an empty
 * migration and the database kept serving the old one. Both sides here are *generated* spellings
 * — `recorded` is a previous migration's own snapshot, never the catalog's rewriting of it — so a
 * text difference in `where` is a real change and not a formatting one.
 */
function redefineIndex(
  table: string,
  index: IndexDescriptionLike,
  recorded: IndexDescription,
  plan: Plan,
): void {
  if (indexShape(index) === indexShape(recorded)) return;
  plan.up.push(`drop index "${index.name}";`, createIndex(table, index));
  // `down` is reversed at assembly, so the pair is pushed forwards and read backwards: recreating
  // the recorded definition is what must land last, after the new one is dropped.
  plan.down.push(
    createIndex(table, {
      name: recorded.name,
      columns: recorded.columns,
      unique: recorded.unique,
      where: recorded.where,
      order: recorded.order,
    }),
    `drop index "${index.name}";`,
  );
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

  const indexed = new Map(live.indexes.map((index) => [index.name, index]));
  for (const index of entity.indexes) {
    const recorded = indexed.get(index.name);
    if (recorded !== undefined) {
      redefineIndex(entity.table, index, recorded, plan);
      continue;
    }
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
  /**
   * Whether `up` destroys data. Read off the generated SQL by the same classifier the gate runs,
   * never assembled a second time from what the diff happened to push — one answer, so a migration
   * cannot be written unmarked and then refused by `x verify` for lacking the mark.
   */
  readonly destructive: boolean;
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
  // Merged into `plan` once every table statement is in, never interleaved with them.
  const constraints: Plan = { up: [], down: [] };
  const wanted = new Set(options.entities.map((entity) => entity.table));

  for (const entity of options.entities) {
    const live = findTable(current, entity.table);
    foreignKeyPlan(entity, live, constraints);
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

  plan.up.push(...constraints.up);
  plan.down.push(...constraints.down);

  const id = `${migrationStamp(options.now ?? systemClock.now())}_${slugify(options.name)}`;
  const up = plan.up.join('\n');
  return {
    id,
    name: options.name,
    fileName: `migrations/${id}.sql`,
    up,
    // Reverse order: the last thing created is the first thing dropped.
    down: [...plan.down].reverse().join('\n'),
    snapshot: snapshotOf(options.entities),
    destructive: isDestructive(up),
  };
}
