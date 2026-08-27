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
 * `drop table`, with `if exists`. A migration that creates a relation and later drops it OWNS
 * neither: re-creating `legacy_audit` by hand afterwards is drift, and a set that only ever grew
 * accepted it forever. `cascade`/`restrict` and a comma list are handled by the caller.
 */
const DROP_TABLE = /^drop\s+table\s+(?:if\s+exists\s+)?/i;

/** `alter table … rename to …` — the old name stops existing and the new one starts. */
const ALTER_TABLE = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?/i;
const RENAME_TO = /^\s*rename\s+to\s+/i;

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
  const owned = new Set<string>();
  applyOwnership(up, owned);
  return [...owned];
}

/**
 * Fold one migration's statements over the owned set, IN ORDER.
 *
 * A set that only ever grew was the defect: `create table legacy_audit` followed by
 * `drop table legacy_audit` left the name accepted, so a `legacy_audit` somebody re-created by
 * hand afterwards lost its `unexpected-table` finding — real drift, silenced, which is the one
 * thing this module may not do.
 *
 * Fail-closed on anything the grammar cannot read: a `drop`/`rename` this cannot parse REMOVES
 * nothing it is unsure about only when it could not name a relation at all; when it can name one,
 * dropping it from the set is always the safe direction, because the cost of being wrong is a
 * difference reported that could have been accepted.
 */
function applyOwnership(up: string, owned: Set<string>): void {
  for (const statement of statementsOf(up)) {
    const created = createdBy(statement);
    if (created !== null) {
      owned.add(created);
      continue;
    }
    for (const dropped of droppedBy(statement)) owned.delete(dropped);
    const renamed = renamedBy(statement);
    if (renamed === null) continue;
    // Only inherit ownership when the OLD name was owned: renaming a hand-made table into a name
    // a migration once created must not launder it into an accepted one.
    owned.delete(renamed.from);
    if (renamed.owned) owned.add(renamed.to);
  }
}

/** Every relation one `drop table` names — the form takes a comma list. */
function droppedBy(statement: string): readonly string[] {
  const text = statement.trimStart();
  const head = DROP_TABLE.exec(text);
  if (head === null) return [];
  const dropped: string[] = [];
  let rest = text.slice(head[0].length);
  for (;;) {
    const name = qualifiedName(rest);
    if (name === null) break;
    if (name.table !== null) dropped.push(name.table);
    if (!/^\s*,/.test(name.rest)) break;
    rest = name.rest.replace(/^\s*,\s*/, '');
  }
  return dropped;
}

/** `alter table <old> rename to <new>`, or `null`. `owned` is filled in by the caller's set. */
function renamedBy(statement: string): { from: string; to: string; owned: boolean } | null {
  const text = statement.trimStart();
  const head = ALTER_TABLE.exec(text);
  if (head === null) return null;
  const source = qualifiedName(text.slice(head[0].length));
  if (source === null || source.table === null) return null;
  const verb = RENAME_TO.exec(source.rest);
  if (verb === null) return null;
  const target = qualifiedName(source.rest.slice(verb[0].length));
  if (target === null || target.table === null) return null;
  return { from: source.table, to: target.table, owned: true };
}

/**
 * One optionally schema-qualified relation name and what follows it. `table` is `null` when the
 * qualifier names a schema `checkDrift` never introspected — the same rule `createdBy` applies.
 */
function qualifiedName(input: string): { table: string | null; rest: string } | null {
  const first = NAME.exec(input);
  if (first === null) return null;
  const tail = input.slice(first[0].length);
  const dot = DOT.exec(tail);
  if (dot === null) return { table: unquote(first), rest: tail };
  const second = NAME.exec(tail.slice(dot[0].length));
  if (second === null) return null;
  const rest = tail.slice(dot[0].length + second[0].length);
  return { table: unquote(first) === COMPARED_SCHEMA ? unquote(second) : null, rest };
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
  // In migration ORDER, across the whole list: ownership is a running state, not a union. A
  // relation created by 0003 and dropped by 0007 is owned by neither.
  const created = new Set<string>();
  for (const migration of migrations) applyOwnership(migration.up, created);
  if (created.size === 0) return report;
  const differences = report.differences.filter(
    (difference) => !(difference.kind === 'unexpected-table' && created.has(difference.table)),
  );
  if (differences.length === report.differences.length) return report;
  return { ok: differences.length === 0, differences };
}
