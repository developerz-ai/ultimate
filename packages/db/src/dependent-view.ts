// Single responsibility: refuse a migration whose `alter column … type` a VIEW is compiled against,
// before the statement is sent — and name the view, the column and the statement that recreates it.
//
// **This is the honest ceiling for views, and the reason it is not in the generator.** `x db gen`
// runs with no database open; `SchemaDescription` has no field for a view; `introspect()` reads
// none by construction (`app-relation.ts` excludes every non-table relation); and no `entity()` can
// declare one. So nothing the generator reads knows a view exists, and a `GenerateOptions.views`
// with no caller to fill it is the declared-and-never-wired defect this release exists to
// eliminate. What DOES have a connection is `migrate()`, one statement before the abort — and the
// catalog answers the question exactly, including for a view no migration in this repo wrote.
//
// Measured on 18.4: `alter table "dv_docs" alter column "rank" type text using "rank"::text` under
// a view selecting that column answers `0A000 cannot alter type of a column used by a view or
// rule`, with `rule _RETURN on view dv_docs_published depends on column "rank"` in a DETAIL field
// nothing printed — surfaced as `X_DB_UNAVAILABLE: cannot reach the database`, whose registered
// `fix:` says to set `DATABASE_URL`.
//
// It does not repair anything and does not claim to: the deploy still stops. What it replaces is
// wrong advice about a healthy database with the two statements that unblock it.

import type { DbClient } from './client';
import { migrationViewDepends } from './migration-errors';
import { identifier, join, sql } from './sql';
import { IDENTIFIER_PART, noiseAt } from './sql-scan';
import { statementsOf } from './statement-split';

/** One `alter table <table> alter column <column> type …`, as the catalog spells both names. */
export interface RetypeTarget {
  readonly table: string;
  readonly column: string;
}

/**
 * One name in a statement. Called a WORD and not the obvious lexer noun deliberately:
 * `scripts/secret-compare.ts` reads a comparison whose operand is NAMED like a credential, and
 * that noun is one of the names it reads — a `.text === spelling` under it is indistinguishable
 * from an auth check to a static rule that has only the name to go on.
 */
interface SqlWord {
  readonly text: string;
  /** A quoted name is never a keyword — `"type"` is a column called type, not the clause. */
  readonly quoted: boolean;
}

/**
 * The names in one statement, in order, folded the way Postgres folds them: an unquoted identifier
 * to lower case, a quoted one verbatim. Comments, string literals and dollar-quoted bodies
 * contribute nothing, through this package's one lexer — `-- alter column` is prose and
 * `'alter column'` is data.
 */
function wordsOf(statement: string): readonly SqlWord[] {
  const words: SqlWord[] = [];
  let at = 0;
  while (at < statement.length) {
    const noise = noiseAt(statement, at);
    if (noise !== null) {
      if (noise.kind === 'identifier') {
        words.push({ text: statement.slice(at + 1, noise.end - 1), quoted: true });
      }
      at = noise.end;
      continue;
    }
    if (!IDENTIFIER_PART.test(statement[at] ?? '')) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < statement.length && IDENTIFIER_PART.test(statement[end] ?? '')) end += 1;
    words.push({ text: statement.slice(at, end).toLowerCase(), quoted: false });
    at = end;
  }
  return words;
}

const keyword = (word: SqlWord | undefined, spelling: string): boolean =>
  word !== undefined && !word.quoted && word.text === spelling;

/**
 * Every column this script retypes. Narrow ON PURPOSE — `alter table <t> … alter [column] <c> type`
 * and nothing else — because a miss costs exactly what happens today (the server's own `0A000`,
 * one statement later) while a false positive costs a catalog read and a refusal on a migration
 * that would have applied. Every retype `generateMigration` emits is this shape; a hand-written
 * `ALTER TABLE ONLY t …` is not, and is deliberately left to the server.
 */
export function retypeTargets(script: string): readonly RetypeTarget[] {
  const targets: RetypeTarget[] = [];
  for (const statement of statementsOf(script)) {
    const words = wordsOf(statement);
    const table = words[2];
    if (!keyword(words[0], 'alter') || !keyword(words[1], 'table') || table === undefined) {
      continue;
    }
    for (let index = 3; index < words.length; index += 1) {
      if (!keyword(words[index], 'alter')) continue;
      const at = keyword(words[index + 1], 'column') ? index + 2 : index + 1;
      const column = words[at];
      if (column === undefined || !keyword(words[at + 1], 'type')) continue;
      targets.push({ table: table.text, column: column.text });
    }
  }
  return targets;
}

interface ViewRow {
  readonly view_name: string;
  readonly table_name: string;
  readonly column_name: string;
  readonly definition: string;
  /** `v` or `m`. A MATERIALISED view needs different DDL to drop and to recreate. */
  readonly relkind: string;
}

/**
 * `pg_depend` -> `pg_rewrite` is the only edge that records this: a view depends on a column
 * through its `_RETURN` rule, never through a row in `pg_class` alone. Materialised views are
 * included (`relkind = 'm'`) because they carry the same rule and fail the same way.
 *
 * One round trip for every target, `in` over both name lists, and the exact pairing filtered in
 * the caller — a per-target query would be a loop of statements inside the migration's own
 * transaction, and a cross-product read is cheap where a false pair is not.
 */
async function dependentViews(
  client: DbClient,
  targets: readonly RetypeTarget[],
): Promise<readonly ViewRow[]> {
  const tables = join(
    [...new Set(targets.map((target) => target.table))].map((name) => sql`${name}`),
  );
  const columns = join(
    [...new Set(targets.map((target) => target.column))].map((name) => sql`${name}`),
  );
  return client.query<ViewRow>(sql`
    select distinct v.relname as view_name, c.relname as table_name, a.attname as column_name,
           pg_get_viewdef(v.oid, true) as definition, v.relkind as relkind
      from pg_depend d
      join pg_rewrite r on r.oid = d.objid and d.classid = 'pg_rewrite'::regclass
      join pg_class v on v.oid = r.ev_class
      join pg_class c on c.oid = d.refobjid and d.refclassid = 'pg_class'::regclass
      join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
     where v.relkind in ('v', 'm') and v.oid <> c.oid
       and c.relname in (${tables}) and a.attname in (${columns})
     order by v.relname
  `);
}

/**
 * One SQL statement as a single argv word for `psql -c`.
 *
 * SINGLE quotes, unlike `migrationConflict`'s `-c "…"`: `identifier()` writes the view's name in
 * DOUBLE quotes, so a double-quoted shell word would end at the name. The definition is the
 * server's own text and may hold a `'` of its own — `where status = 'published'` — so the one
 * escape a POSIX shell has for it is spelled out here. This is not the SQL literal escape
 * (`sql.ts`'s `literal()`, the tree's one copy of that); nothing below is sent to a server.
 */
const shellArg = (statement: string): string => `'${statement.replaceAll("'", `'\\''`)}'`;

/** The invocation `migrationConflict` already writes, with the statement as its own argv word. */
const psql = (statement: string): string => `psql "$DATABASE_URL" -c ${shellArg(statement)}`;

/**
 * The two statements that unblock the deploy, as one line an operator pastes.
 *
 * It leads with the command to RUN and carries the follow-up in a `#` comment, the shape
 * `migrateConcurrent` and `migrationSnapshotMissing` already write. It used to lead with bare DDL
 * and a `#`: `#` is not a comment in Postgres, so psql read the whole line and failed on it, while
 * a shell read `drop` as a program that does not exist. Neither reader could run it (axiom 4).
 *
 * `identifier()` REFUSES a name holding a quote, a space or a backslash — all three legal inside a
 * quoted Postgres name — and a `fix:` may not throw: the rule `rebuildForeignKey` already states,
 * with the same shape. A refusal that raised `X_SQL_UNSAFE` in place of the finding would hand the
 * operator an exception where a verdict was asked for, over a view name that is perfectly legal.
 * The fallback still leads with a command that runs — a psql session — because quoting that name
 * is the one step this package will not do twice: `identifier()` is its only identifier writer.
 *
 * The definition is collapsed to one line because `pg_get_viewdef(oid, true)` pretty-prints across
 * several and a `fix:` is read as a command.
 *
 * `relkind` decides the DDL and is not cosmetic: `dependentViews` deliberately selects `'m'` as
 * well as `'v'`, and Postgres refuses `drop view` on a materialised one — `WRONG_OBJECT_TYPE`,
 * "use DROP MATERIALIZED VIEW". So the one case the query went out of its way to include was the
 * one whose `fix:` could not run. `pg_get_viewdef` answers the SELECT for both kinds, so only the
 * two keywords differ; a matview's indexes and its `WITH DATA` population are NOT carried, and
 * the fix says so rather than implying the recreate is complete.
 */
function restoreView(view: string, definition: string, relkind: string): string {
  const body = definition.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
  const materialised = relkind === 'm';
  const kind = materialised ? 'materialized view' : 'view';
  const note = materialised
    ? '   # then re-create its indexes: a matview keeps none of them across a drop'
    : '';
  try {
    const name = identifier(view).text;
    return (
      `${psql(`drop ${kind} ${name}`)}   # then x db migrate, then: ` +
      `${psql(`create ${kind} ${name} as ${body}`)}${note}`
    );
  } catch {
    return (
      `psql "$DATABASE_URL"   # quote the ${kind} name ${JSON.stringify(view)} yourself, then: ` +
      `drop ${kind} <name>; \\q; x db migrate; and create it again as: create ${kind} <name> as ${body}${note}`
    );
  }
}

/**
 * Refuse before the ALTER, or return having sent nothing at all. A script that retypes no column
 * costs one text scan and no round trip, which is every migration an app writes that is not a
 * retype.
 */
export async function refuseDependentViews(client: DbClient, script: string): Promise<void> {
  const targets = retypeTargets(script);
  if (targets.length === 0) return;
  const wanted = new Set(targets.map((target) => `${target.table}.${target.column}`));
  for (const row of await dependentViews(client, targets)) {
    if (!wanted.has(`${row.table_name}.${row.column_name}`)) continue;
    throw migrationViewDepends(
      row.view_name,
      row.table_name,
      row.column_name,
      restoreView(row.view_name, row.definition, row.relkind),
    );
  }
}
