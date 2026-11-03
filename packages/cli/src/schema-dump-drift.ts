// The `drift` step's fourth rail: is the committed schema dump what the migrations produce, does
// it hold what their snapshots record, and does a database loaded from it come back the same? The other three rails read files and open
// nothing; this one replays the migrations on a scratch embedded database, because "what the
// migrations produce" is a fact only a database can state.

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
import { quoteArg } from './shell-quote';

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
  return [
    ...columns,
    ...[...compareSchemaDump(committed, replayed.files), ...replayed.reload].map(findingFor),
  ];
}
