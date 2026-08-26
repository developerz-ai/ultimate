// Single responsibility: turn an entity snapshot into a timestamped, reversible migration.
// `db` is tier 1 and cannot import `@ultimat3/entity`, so the snapshot arrives as a parameter —
// the CLI passes `describeEntities()` and the types below mirror `EntityDescription` field for
// field. Every generated migration must be reversible; a drop that loses data refuses instead.

import { systemClock } from '@ultimat3/core';
import { checkClauses, checkPlan, declaredChecks } from './check-ddl';
import { defaultExpression } from './column-default';
import { isDestructive } from './destructive';
import { dropOrder } from './drop-order';
import type { ColumnDescriptionLike, EntityDescriptionLike } from './entity-shape';
import { type ConstraintPlans, foreignKeyPlan, foreignKeysOf, type Plan } from './foreign-key-plan';
import type { Regeneration } from './generated-column';
import { generatedClause, isGenerated, regenerate } from './generated-column';
import { createIndex, dropIndex, impliedByColumnClause, redefineIndex } from './index-ddl';
import {
  type ColumnDescription,
  findTable,
  type SchemaDescription,
  type TableDescription,
} from './introspect';
import { declaredIndexes } from './invariant-ddl';
import { migrationIrreversible } from './migration-errors';
import type { MovedAside } from './retype-dependents';
import { moveDependentsAside } from './retype-dependents';
import { moveKeysAside, retypedColumns, retypedIn } from './retype-keys';
import { identifier } from './sql';
import { sqlType } from './sql-type';
import { type UnrenderedDeclaration, unrenderedComment, unrenderedOf } from './unrendered';

function columnClause(column: ColumnDescriptionLike): string {
  // The generation clause sits directly after the type, and `generatedClause` refuses the pairs
  // Postgres has no column for. Every other part below is unchanged and unreachable for a
  // generated column: it may carry no default, and `hasDefault` is what the refusal reads.
  //
  // Through `identifier`, never `"${…}"`: the name arrives from a projection this package cannot
  // typecheck and a name that closes its own quote produced a real `drop table` through
  // `generateMigration` once already. It is also what makes an unrendered report safe to write
  // into a `--` comment, since generation refuses the dangerous name before the comment exists.
  const parts = [
    identifier(column.column).text,
    `${sqlType(column.kind)}${generatedClause(column)}`,
  ];
  const expression = defaultExpression(column);
  if (expression !== null) parts.push(`default ${expression}`);
  if (column.notNull) parts.push('not null');
  if (column.unique && !column.primaryKey) parts.push('unique');
  // No `check` clause — written here it was ANONYMOUS and reached `create table` alone, so
  // regenerating dropped the value set `enumerated()` declares; `check-ddl.ts` owns every CHECK now.
  // No `references` clause either: a foreign key is `alter table … add constraint`, emitted after
  // every table exists (`foreignKeyPlan`) — inline it must point at a table that already exists, and
  // entity registration order is the app's import order, which says nothing about that.
  return parts.join(' ');
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
          // Only when one was declared — absent stays absent, so no snapshot written before this
          // field existed gains a key and no app's sidecar regenerates over a fact already true.
          ...(column.generated === undefined ? {} : { generated: column.generated }),
        }));
      const checks = declaredChecks(entity);
      return {
        schema: 'public',
        name: entity.table,
        columns,
        primaryKey: [...entity.primaryKey],
        // Whole, never partly: a snapshot that recorded the name and dropped the predicate made
        // the next generation blind to a `where` or an `order` changing, and a partial index
        // silently kept as a total one is a constraint the entity no longer declares.
        //
        // `declaredIndexes`, so a `unique` invariant's index is recorded exactly like an entity's
        // own — a statement emitted and not recorded is `42P07` on the very next `x db gen`.
        indexes: declaredIndexes(entity).map((index) => ({
          name: index.name,
          columns: [...index.columns],
          unique: index.unique,
          primary: false,
          where: index.where,
          order: index.order,
          // Only when one was declared. Writing `using: 'btree'` out for every index would rewrite
          // every sidecar in every app on the next `x db gen` — a diff on every file for a fact
          // that was already true, which `indexMethodOf` reads out of the absence anyway.
          ...(index.using === undefined ? {} : { using: index.using }),
        })),
        foreignKeys: foreignKeysOf(entity),
        // Absent, never `[]`, on a table declaring none: a sidecar that predates this field must
        // read as "nothing recorded" so the next generation adds the constraints the database is
        // genuinely missing — the rule `using` and `generated` already state one field up.
        ...(checks.length === 0 ? {} : { checks }),
      };
    });
  return { tables };
}

function createTable(entity: EntityDescriptionLike): readonly string[] {
  const clauses = entity.columns.map(columnClause);
  if (entity.primaryKey.length > 0) {
    const key = entity.primaryKey.map((column) => identifier(column).text).join(', ');
    clauses.push(`primary key (${key})`);
  }
  // After the key, so a table declaring no invariant emits the statement it always emitted.
  clauses.push(...checkClauses(entity));
  const statements = [
    `create table ${identifier(entity.table).text} (\n  ${clauses.join(',\n  ')}\n);`,
  ];
  // Every column of a new table carries its own clause, so every `unique` one brings its index.
  const added = new Set(entity.columns.map((column) => column.column));
  for (const index of declaredIndexes(entity)) {
    if (impliedByColumnClause(entity, index, added)) continue;
    statements.push(createIndex(entity.table, index));
  }
  return statements;
}

/**
 * Skipping an existing column by name alone missed the type moving under it: a table created
 * while money's currency was bare `char` keeps `char(1)` and rejects every ISO 4217 code, yet the
 * snapshot this run records claims `char(3)` — two claims with no statement between them. Both
 * sides are generated spellings (`current` is a previous migration's own snapshot), so any
 * difference is a real kind change, not a catalog alias.
 *
 * The ALTER is not the whole statement list: Postgres compiled every predicate written against
 * this column with its OLD type and cannot recompile one, so a partial index or a CHECK that reads
 * it is dropped FIRST and `moved` carries the names on to the arms that would otherwise act on
 * them. Without that the retype is `42883` and the migration aborts mid-run
 * (`retype-dependents.ts`).
 */
function retypeColumn(
  live: TableDescription,
  column: ColumnDescriptionLike,
  recorded: ColumnDescription,
  plan: Plan,
  moved: MovedAside,
  retyped: ReadonlySet<string>,
): Regeneration {
  const wanted = sqlType(column.kind);
  const table = live.name;
  // A generated column moves by its own rules — see `generated-column.ts`. Asked whenever EITHER
  // side is one, because becoming generated and ceasing to be are both changes with a statement.
  if (isGenerated(column) || recorded.generated !== undefined) {
    return regenerate(live, column, wanted, recorded, plan, moved);
  }
  // The set, never `recorded.dataType === wanted` a second time: `retypedColumns` decided this for
  // the whole schema before any statement was written, because the foreign keys a retype breaks
  // are recorded on tables this diff is not looking at (`retype-keys.ts`).
  if (!retyped.has(column.column)) return 'unchanged';
  moveDependentsAside(live, column.column, plan, moved);
  const alter = (type: string): string =>
    `alter table ${identifier(table).text} alter column ${identifier(column.column).text} ` +
    `type ${type} using ${identifier(column.column).text}::${type};`;
  plan.up.push(alter(wanted));
  plan.down.push(alter(recorded.dataType));
  return 'altered';
}

function diffTable(
  entity: EntityDescriptionLike,
  live: TableDescription,
  plan: Plan,
  retyped: ReadonlySet<string>,
): void {
  const existing = new Map(live.columns.map((column) => [column.name, column]));
  const added = new Set<string>();
  // A column `regenerate` had to replace outright: `add column` implies no index, so every index
  // over it has to be stated again even though its own definition never moved.
  const rebuilt = new Set<string>();
  // What a retype dropped ahead of itself, read by the two arms below.
  const moved: MovedAside = { indexes: new Set(), checks: new Set() };
  for (const column of entity.columns) {
    const recorded = existing.get(column.column);
    if (recorded !== undefined) {
      if (retypeColumn(live, column, recorded, plan, moved, retyped) === 'rebuilt') {
        rebuilt.add(column.column);
      }
      continue;
    }
    added.add(column.column);
    // A NOT NULL add with no default cannot succeed on a populated table; emit it nullable and
    // leave the agent the exact follow-up rather than a migration that fails at 3am.
    //
    // A GENERATED column is the exception and not a special case of it: the database computes it
    // for every existing row inside the same `add column`, so it lands NOT NULL and populated in
    // one statement — measured. Emitting it nullable would leave a `-- backfill` comment naming a
    // step nobody can perform, since a generated column cannot be written to.
    const nullable = column.notNull && !isGenerated(column) && defaultExpression(column) === null;
    const clause = nullable ? columnClause({ ...column, notNull: false }) : columnClause(column);
    plan.up.push(`alter table ${identifier(entity.table).text} add column ${clause};`);
    if (nullable) {
      plan.up.push(
        `-- backfill ${identifier(column.column).text}, then: alter table ` +
          `${identifier(entity.table).text} alter column ${identifier(column.column).text} set not null;`,
      );
    }
    plan.down.push(
      `alter table ${identifier(entity.table).text} drop column ${identifier(column.column).text};`,
    );
  }

  const indexed = new Map(live.indexes.map((index) => [index.name, index]));
  for (const index of declaredIndexes(entity)) {
    const recorded = indexed.get(index.name);
    // A rebuilt column took its indexes down with it, and a retype dropped the ones whose
    // predicate it could not survive — either way this one is CREATED rather than compared:
    // `redefineIndex` sees a definition that never moved and would emit nothing at all.
    const gone = moved.indexes.has(index.name) || index.columns.some((each) => rebuilt.has(each));
    if (recorded !== undefined && !gone) {
      redefineIndex(entity.table, index, recorded, plan);
      continue;
    }
    // `added` only: an index over a column that was already there is implied by no clause this
    // migration emits, so it still needs a statement of its own.
    if (impliedByColumnClause(entity, index, added)) continue;
    plan.up.push(createIndex(entity.table, index));
    plan.down.push(dropIndex(index.name));
  }

  // Last: a CHECK may read a column this migration just added, and `add constraint` on a column
  // that does not exist yet is `42703`. `check-ddl.ts` owns which of them move; `rebuilt` because a
  // column dropped and re-added lost its constraint while the snapshot still records it, and
  // `moved.checks` because a retype already dropped the ones written against the old type.
  checkPlan(entity, live, plan, rebuilt, moved.checks);
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
  /**
   * Every declaration this generator could not write down. Empty on a migration that carries the
   * whole schema, which is what makes it readable as a verdict rather than as noise — and the same
   * list `unrenderedComment` writes into the top of `up`, so a caller that would rather refuse
   * (`x db gen`) and a reviewer reading the committed file are looking at one answer.
   */
  readonly unrendered: readonly UnrenderedDeclaration[];
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
  // Merged in BEFORE them, for the mirror-image reason: a key still pointing at a table this
  // migration drops makes that `drop table` `2BP01`.
  const preDrops: Plan = { up: [], down: [] };
  // Ahead of EVERYTHING, and at the far end of `down`: a foreign key compiled against a column
  // being retyped has to be gone before the first ALTER and back after the last one, and both ends
  // of one key can move in two different entities' diffs (`retype-keys.ts`).
  const preAlters: Plan = { up: [], down: [] };
  const wanted = new Set(options.entities.map((entity) => entity.table));

  const doomed = new Set(
    current.tables.filter((table) => !wanted.has(table.name)).map((table) => table.name),
  );
  // Before the loop, because the answer spans it: `diffTable` is handed one entity's recorded row
  // and the key that a retype of its column breaks is recorded on whichever table OWNS the key.
  const retyped = retypedColumns(options.entities, current);
  const predropped = moveKeysAside(current, retyped, doomed, preAlters);
  const plans: ConstraintPlans = { constraints, preDrops, doomed, predropped };

  for (const entity of options.entities) {
    const live = findTable(current, entity.table);
    foreignKeyPlan(entity, live, plans);
    if (live === undefined) {
      plan.up.push(...createTable(entity));
      plan.down.push(`drop table ${identifier(entity.table).text};`);
      continue;
    }
    diffTable(entity, live, plan, retypedIn(retyped, entity.table));
    const kept = new Set(entity.columns.map((column) => column.column));
    for (const column of live.columns) {
      if (kept.has(column.name)) continue;
      if (options.allowDestructive !== true) {
        throw migrationIrreversible(
          `dropping "${entity.table}"."${column.name}" discards its rows and cannot be undone`,
          `x db gen "${options.name}" --allow-destructive   # or keep the column and deprecate it`,
        );
      }
      plan.up.push(
        `alter table ${identifier(entity.table).text} drop column ${identifier(column.name).text};`,
      );
      plan.down.push(
        `alter table ${identifier(entity.table).text} add column ` +
          `${identifier(column.name).text} ${column.dataType};` +
          ' -- data is not restored',
      );
    }
  }

  const order = dropOrder(current.tables.filter((table) => !wanted.has(table.name)));
  for (const table of order.tables) {
    if (options.allowDestructive !== true) {
      throw migrationIrreversible(
        `dropping table "${table.name}" discards every row and cannot be undone`,
        `x db gen "${options.name}" --allow-destructive   # or delete the entity in two releases`,
      );
    }
  }
  plan.up.push(...preDrops.up, ...order.constraints);
  plan.down.push(...preDrops.down, ...order.constraints.map(() => '-- constraint not restored'));
  for (const table of order.tables) {
    plan.up.push(`drop table ${identifier(table.name).text};`);
    // `identifier` in a comment too: a `--` ends at the first newline, so a name holding one
    // would put a second command on the next line of `down`.
    plan.down.push(
      `-- ${identifier(table.name).text} cannot be restored; recover it from a backup`,
    );
  }

  plan.up.push(...constraints.up);
  plan.down.push(...constraints.down);

  const id = `${migrationStamp(options.now ?? systemClock.now())}_${slugify(options.name)}`;
  // At the TOP of `up`, so what is MISSING is the first thing read — and a line comment, so it is
  // noise to every reader that matters: `statementsOf` drops a chunk of comments alone,
  // `stripSqlNoise` blanks it before `isDestructive` looks for a verb, and the server ignores it.
  //
  // Never onto an EMPTY diff. `@ultimat3/cli`'s `generateAppMigration` reads `up.trim().length` as
  // "nothing changed" and re-records the hash sidecar instead of writing a file; a comment there
  // would make every `x db gen` on an app with an unrendered default write a migration holding no
  // statement — a ledger row, a checksum and a place in the apply order for nothing. The list is
  // still on `GeneratedMigration.unrendered`, which is where a caller with no file reads it.
  //
  // `current`, not the entities alone: an `assert` whose CHECK a previous migration recorded is a
  // loss only because THIS plan drops it, and the recorded schema is the only thing that knows.
  const unrendered = unrenderedOf(options.entities, current);
  const body = [...preAlters.up, ...plan.up].join('\n');
  const up = body.length === 0 ? body : unrenderedComment(unrendered) + body;
  return {
    id,
    name: options.name,
    fileName: `migrations/${id}.sql`,
    up,
    // Reverse order: the last thing created is the first thing dropped. `preAlters` goes in at the
    // FRONT here precisely so reversal puts it last — a key is added back only once both of its
    // ends have been retyped back, which is every other statement in the script.
    down: [...preAlters.down, ...plan.down].reverse().join('\n'),
    snapshot: snapshotOf(options.entities),
    destructive: isDestructive(up),
    unrendered,
  };
}
