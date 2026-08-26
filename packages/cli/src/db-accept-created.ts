// Single responsibility: accept a table an applied migration's own SQL created. A snapshot records
// only what ENTITIES declare, so a hand-written `create table` is `unexpected-table` on every
// deploy forever (issue #345) — and the migration list `x db migrate` has just applied is the one
// piece of evidence that the app owns the relation. Named in `@ultimat3/db`'s `unexpectedTable`.

import type { DriftReport, Migration } from '@ultimat3/db';
import { statementsOf } from '@ultimat3/db';

/**
 * `create table`, `create unlogged table`, either with `if not exists`. Anchored, so only the verb
 * phrase a statement OPENS with counts.
 *
 * `temp`/`temporary` is deliberately absent: a temporary table lives in `pg_temp` and can never be
 * the relation `checkDrift` introspected, so reading one as evidence would accept a `drafts`
 * somebody created by hand on the strength of SQL that never touched it.
 */
const CREATE_TABLE = /^create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?/i;

/**
 * One identifier: quoted (with `""` for a literal quote) or bare. The bare form is Postgres' own
 * charset — a letter or `_` to open, then letters, digits, `_` and `$` — with everything above
 * ASCII admitted, since the server accepts any multibyte letter and a name it accepts must be
 * readable here or the relation behind it is drift nobody can clear.
 */
const NAME = /^(?:("(?:[^"]|"")+")|([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*))/;

/** A qualifier's dot, with the whitespace Postgres allows on either side of it. */
const DOT = /^\s*\.\s*/;

/** The schema `checkDrift` compares — `introspect()`'s default, and what `runMigrations` asks for. */
const COMPARED_SCHEMA = 'public';

/**
 * Postgres folds an unquoted identifier to lower case and stores a quoted one verbatim, so
 * `CREATE TABLE LegacyAudit` and `create table legacyaudit` are the same relation and
 * `"LegacyAudit"` is a different one. The catalog name is what a drift difference carries, so the
 * fold has to happen here or the comparison misses on every unquoted name that was not typed flat.
 */
function unquote(match: RegExpExecArray): string {
  const quoted = match[1];
  if (quoted === undefined) return (match[2] ?? '').toLowerCase();
  return quoted.slice(1, -1).replaceAll('""', '"');
}

/**
 * The relation one statement creates, or `null`.
 *
 * **The anchor is the whole protection**, and it is read off the raw text. A statement can only
 * open with `create table` by BEING one: `values ('create table ghost')` opens with `insert`, and
 * a chunk that is nothing but a comment is not a statement at all (`statementsOf` drops it). A
 * `stripSqlNoise` pass was written here first and then deleted — it could not change one answer,
 * because position 0 is the one position no literal, comment or dollar body can cover, and a
 * defence that cannot fail is a defence nobody can test.
 *
 * Anything the anchor admits but the name grammar does not — a comment between the keywords,
 * `create table (` — contributes nothing. Fail-closed: drift that could have been accepted is
 * reported, never the reverse.
 */
function createdBy(statement: string): string | null {
  const text = statement.trimStart();
  const head = CREATE_TABLE.exec(text);
  if (head === null) return null;
  const rest = text.slice(head[0].length);
  const first = NAME.exec(rest);
  if (first === null) return null;

  const tail = rest.slice(first[0].length);
  const dot = DOT.exec(tail);
  if (dot === null) return unquote(first);
  const second = NAME.exec(tail.slice(dot[0].length));
  if (second === null) return null;
  // A qualifier naming another schema is evidence about a relation this report never mentions:
  // `checkDrift` introspects one schema, and `audit.drafts` is not the `drafts` it compared.
  return unquote(first) === COMPARED_SCHEMA ? unquote(second) : null;
}

/**
 * Every relation a migration script creates, in statement order.
 *
 * `statementsOf` is `@ultimat3/db`'s own splitter — the one `x db migrate` sends by — so a `;`
 * inside a literal, an identifier or a dollar-quoted body is not a statement boundary here either.
 */
export function createdTables(up: string): readonly string[] {
  const created: string[] = [];
  for (const statement of statementsOf(up)) {
    const name = createdBy(statement);
    if (name !== null) created.push(name);
  }
  return created;
}

/**
 * The drift report minus the tables these migrations demonstrably create.
 *
 * **Only `unexpected-table`, and only for a name a migration's SQL creates.** That is what makes
 * this an acceptance and not the check switched off: a table absent from the snapshot produces
 * exactly ONE difference (`diffSchema` reports it and never compares its columns), so nothing else
 * about the relation was being said, and every difference about a table that IS declared — a
 * missing column, a changed index, a dropped constraint — passes through untouched.
 *
 * The migrations are the list `x db migrate` applied immediately before the check, which is why
 * "created" is provable rather than assumed: `runMigrations` applies every pending file and then
 * asks, so a `create table` still on disk and unapplied is not one this path can be handed.
 *
 * Identity in, identity out when nothing matched — a report this has nothing to say about is not
 * its to rebuild.
 */
export function acceptCreatedTables(
  report: DriftReport,
  migrations: readonly Migration[],
): DriftReport {
  const created = new Set(migrations.flatMap((migration) => createdTables(migration.up)));
  if (created.size === 0) return report;
  const differences = report.differences.filter(
    (difference) => !(difference.kind === 'unexpected-table' && created.has(difference.table)),
  );
  if (differences.length === report.differences.length) return report;
  return { ok: differences.length === 0, differences };
}
