// The `drift` step's fourth rail: is the committed dump what the migrations produce, does it hold
// what their snapshots record, and does it load back the same? Only a scratch database can state
// what migrations produce and what a view outputs. Beside it, with none: an index the dump holds
// and nothing declares (`X_DB_INDEX_UNDECLARED`), a warning on `main`.

// why: Bun has no directory probe — `Bun.file().exists()` answers about a file.
import { existsSync } from 'node:fs';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Migration } from '@ultimat3/db';
import { ungeneratableStatements } from '@ultimat3/db';
import type { SchemaDumpDifference, SchemaDumpFile } from '@ultimat3/db/schema-dump';
import { compareSchemaDump, schemaDumpDrift } from '@ultimat3/db/schema-dump';
import {
  hasSchemaDump,
  type ReplayedSchema,
  readSchemaDump,
  replayFor,
  SCHEMA_DUMP_DIR,
} from './db-schema-dump';
import { dumpNeverGenerated, replayFailure } from './db-schema-refresh';
import { DB_PACKAGE } from './drift';
import { MIGRATIONS_DIR, readMigrations } from './migrations';
import type { Finding } from './output';
import { findingFrom } from './output';
import { appEntities, type DeclaredEntities } from './schema-drift';
import { quoteArg } from './shell-quote';
import { viewColumnFindings } from './view-drift';

/** Injected so this module's rules are testable without booting a database per case. */
export type SchemaReplay = (migrations: readonly Migration[]) => Promise<ReplayedSchema>;

const findingFor = (difference: SchemaDumpDifference): Finding => ({
  ...findingFrom(schemaDumpDrift(difference)),
  docs: ERROR_DOCS_URL,
  at: `${SCHEMA_DUMP_DIR}/${difference.path}`,
});

/** One `  "name" type…,` line of a generated `create table`; a `constraint` line opens with no quote. */
const DUMP_COLUMN = /^ {2}"((?:[^"]|"")+)" /gm;

const dumpColumns = (sql: string): readonly string[] =>
  [...sql.matchAll(DUMP_COLUMN)].map((match) => (match[1] ?? '').replaceAll('""', '"'));

/** The tables a statement alters or creates, as written: optionally schema-qualified, quoted or not. */
const TABLE_STATEMENT =
  /\b(?:alter|create|drop)\s+(?:unlogged\s+|temp(?:orary)?\s+)?table\s+(?:if\s+(?:not\s+)?exists\s+)?(?:only\s+)?(?:(?:"[^"]+"|[\w$]+)\.)?(?:"([^"]+)"|([\w$]+))/gi;

/** As Postgres names it: an unquoted identifier folds to lower case, a quoted one is kept. */
const tablesNamedBy = (sql: string): readonly string[] =>
  [...sql.matchAll(TABLE_STATEMENT)].flatMap((match) => {
    const name = match[1] ?? match[2]?.toLowerCase();
    return name === undefined ? [] : [name];
  });

/**
 * Tables whose columns a snapshot cannot speak for: `x db gen` writes a snapshot from the entities,
 * so hand-written SQL is on no snapshot. That is every migration holding statements it could not have
 * generated, and every one newer than the newest snapshot, which is a file somebody wrote by hand.
 */
const handWrittenTables = (migrations: readonly Migration[], newest: number): Set<string> => {
  const tables = new Set<string>();
  migrations.forEach((migration, index) => {
    const sql = index > newest ? migration.up : ungeneratableStatements(migration.up).join(';\n');
    for (const table of tablesNamedBy(sql)) tables.add(table);
  });
  return tables;
};

/**
 * The rail the replay below cannot be: the dump IS that replay's output, so an edited migration
 * regenerates into it and both sides agree. The snapshot was written from the entities and did not
 * move. No database, and read beside the replay's findings rather than ahead of them: an edited
 * migration and a stale file are two repairs.
 */
function dumpColumnFindings(
  migrations: readonly Migration[],
  committed: readonly SchemaDumpFile[],
): readonly Finding[] {
  const newest = migrations.findLastIndex((migration) => migration.snapshot !== undefined);
  const snapshot = migrations[newest]?.snapshot;
  if (snapshot === undefined) return [];
  const exempt = handWrittenTables(migrations, newest);
  const files = new Map(committed.map((file) => [file.path, file.content]));
  return snapshot.tables.flatMap((table) => {
    const path = `04_tables/${table.name}.sql`;
    const held = files.get(path);
    if (held === undefined || exempt.has(table.name)) return [];
    const dumped = dumpColumns(held);
    const recorded = table.columns.map((column) => column.name);
    const extra = dumped.filter((name) => !recorded.includes(name));
    const lost = recorded.filter((name) => !dumped.includes(name));
    if (extra.length === 0 && lost.length === 0) return [];
    const said = [
      ...extra.map((name) => `"${name}" is in the dump`),
      ...lost.map((name) => `"${name}" is only in the snapshot`),
    ].join(', ');
    return [
      {
        code: 'X_DB_DRIFT',
        cause: `the dump holds a column no migration's snapshot records, in table "${table.name}": ${said}`,
        fix: `git checkout -- ${quoteArg(MIGRATIONS_DIR)} ${quoteArg(SCHEMA_DUMP_DIR)}   # an applied migration was edited: restore it. Meant it: declare the column on its entity, then x db gen "<change>"`,
        docs: ERROR_DOCS_URL,
        at: `${SCHEMA_DUMP_DIR}/${path}`,
      },
    ];
  });
}

/**
 * Empty result = the dump is the migrations' own.
 *
 * An app with no migration and no dump owes none — zero recorded against zero dumped is agreement,
 * the rule `checkSourceDrift` states for entities, and what keeps `x new --no-example` green. From
 * the first migration on the dump is owed: a missing directory is one finding naming the command
 * that writes it, reported without booting a database.
 *
 * Both halves are reported together. A stale file and a dump that does not round-trip are two
 * repairs, and hiding the second behind the first hands out `x db gen` for a dump regenerating
 * cannot fix.
 */
export async function checkSchemaDump(
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  replay: SchemaReplay = replayFor(root, env, true),
  declared: DeclaredEntities = appEntities,
): Promise<readonly Finding[]> {
  if (!existsSync(join(root, DB_PACKAGE))) return [];
  const migrations = await readMigrations(root);
  if (!hasSchemaDump(root)) return migrations.length === 0 ? [] : [dumpNeverGenerated()];
  const committed = await readSchemaDump(root);
  const columns = dumpColumnFindings(migrations, committed);
  let replayed: ReplayedSchema;
  try {
    replayed = await replay(migrations);
  } catch (error) {
    return [...columns, replayFailure(error)];
  }
  // Only a replay that created a view loads the app: what a view outputs is the one column list
  // no snapshot records, and an app with no view owes this rail nothing.
  const entities = replayed.catalog.views.length === 0 ? undefined : await declared(root);
  return [
    ...columns,
    ...[...compareSchemaDump(committed, replayed.files), ...replayed.reload].map(findingFor),
    ...(entities === undefined ? [] : viewColumnFindings(entities, replayed.catalog)),
  ];
}

/** One `CREATE [UNIQUE] INDEX name ON [ONLY] schema.table` of `pg_get_indexdef`, quoted only when it must be. */
const DUMP_INDEX =
  /^CREATE (?:UNIQUE )?INDEX (?:"((?:[^"]|"")+)"|(\S+)) ON (?:ONLY )?(?:"(?:[^"]|"")+"|[^\s."]+)\.(?:"((?:[^"]|"")+)"|(\S+)) /gm;

const unquoted = (quoted: string | undefined, bare: string | undefined): string =>
  quoted === undefined ? (bare ?? '') : quoted.replaceAll('""', '"');

interface DumpedIndex {
  readonly name: string;
  readonly table: string;
  readonly path: string;
}

/** The app's own: `framework/` holds the tables the framework's migrations own, which it declares. */
const dumpedIndexes = (committed: readonly SchemaDumpFile[]): readonly DumpedIndex[] =>
  committed
    .filter((file) => file.path.startsWith('05_indexes/'))
    .flatMap((file) =>
      [...file.content.matchAll(DUMP_INDEX)].map((match) => ({
        name: unquoted(match[1], match[2]),
        table: unquoted(match[3], match[4]),
        path: file.path,
      })),
    );

const undeclaredIndex = (index: DumpedIndex): Finding => ({
  code: 'X_DB_INDEX_UNDECLARED',
  cause: `the schema dump holds index "${index.name}" on table "${index.table}", which neither the newest migration snapshot nor any entity declares: every write maintains an index nothing asked for`,
  fix: `DROP INDEX CONCURRENTLY IF EXISTS "${index.name}";   # a hand-written migration of its own under ${MIGRATIONS_DIR} with -- transaction: false. Meant to keep it: declare it in the "${index.table}" entity's indexes: [...], then x db gen "<change>"`,
  docs: ERROR_DOCS_URL,
  at: `${SCHEMA_DUMP_DIR}/${index.path}`,
});

/**
 * The dump's own indexes against the newest snapshot and the entities. The replay cannot see this
 * one either: a generated migration that records an index as renamed without dropping the old name
 * replays into a dump holding both, and every snapshot since agrees with the entities. A registry
 * that did not load answers nothing, since "declared by neither" is then not a fact; the entities
 * are only asked for once the snapshot leaves an index unexplained.
 */
export async function undeclaredIndexFindings(
  root: string,
  declared: DeclaredEntities = appEntities,
): Promise<readonly Finding[]> {
  if (!existsSync(join(root, DB_PACKAGE)) || !hasSchemaDump(root)) return [];
  const migrations = await readMigrations(root);
  const snapshot = migrations.findLast((migration) => migration.snapshot !== undefined)?.snapshot;
  const recorded = new Set(
    (snapshot?.tables ?? []).flatMap((table) => table.indexes.map((one) => one.name)),
  );
  const unexplained = dumpedIndexes(await readSchemaDump(root)).filter(
    (index) => !recorded.has(index.name),
  );
  if (unexplained.length === 0) return [];
  const entities = await declared(root);
  if (entities === undefined) return [];
  const named = new Set(entities.flatMap((entity) => entity.indexes.map((one) => one.name)));
  return unexplained.filter((index) => !named.has(index.name)).map(undeclaredIndex);
}

/**
 * What the `drift` step carries on `main`: advice in `StepOutcome.warnings`, never a failed step —
 * a red gate on an app that passed yesterday is X_BREAKING_ON_MAIN. The refusal lands on `next`,
 * where the step reports `undeclaredIndexFindings` as findings.
 */
export async function undeclaredIndexWarnings(
  root: string,
  declared: DeclaredEntities = appEntities,
): Promise<readonly string[]> {
  return (await undeclaredIndexFindings(root, declared)).map(
    (finding) => `${finding.code} ${finding.at}: ${finding.cause} — fix: ${finding.fix}`,
  );
}
