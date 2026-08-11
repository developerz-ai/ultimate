// Enforcement for the dev server's two dangerous tools: `db.query` must be read-only and
// `db.migrate` must be pointed at a branch database.
//
// A description saying "read-only" is documentation; documentation is not a guarantee. The
// gate is structural: one statement, an allowed leading keyword, and no mutating keyword
// anywhere at statement level (which also catches a data-modifying CTE — `WITH x AS
// (INSERT ...) SELECT`, which reads like a SELECT and is not one).

import { McpNotBranchDbError, McpQueryRejectedError } from './errors';

/** Named in `db.query`'s `guards`, so a caller can see that layer 3 actually ran. */
export const PARSE_GUARD = 'parse:single-read';

/** Statements that may begin a read-only query. */
const READ_LEADERS = new Set(['select', 'with', 'explain', 'show', 'table', 'values']);

/**
 * Keywords that make a statement a write. Includes transaction control (a session the tool
 * left open is a lock held on a shared dev DB), `set`/`copy` (session mutation, file I/O),
 * and `analyze` — `EXPLAIN ANALYZE` executes the plan and `ANALYZE t` rewrites statistics,
 * so both are refused rather than special-cased. One rule, no exceptions to remember.
 */
const WRITE_KEYWORDS = new Set([
  'alter',
  'analyze',
  'begin',
  'call',
  'cluster',
  'comment',
  'commit',
  'copy',
  'create',
  'deallocate',
  'declare',
  'delete',
  'discard',
  'do',
  'drop',
  'execute',
  'grant',
  'import',
  'insert',
  'listen',
  'lock',
  'merge',
  'move',
  'notify',
  'prepare',
  'reassign',
  'refresh',
  'reindex',
  'release',
  'rename',
  'reset',
  'revoke',
  'rollback',
  'savepoint',
  'security',
  'set',
  'start',
  'truncate',
  'unlisten',
  'update',
  'vacuum',
]);

/**
 * Function families a read may not call, matched as a PREFIX of a CALLED function name.
 *
 * The family is the unit, never the name. Refusing `pg_sleep` while admitting `pg_sleep_for` is a
 * distinction only this parser draws, and an exact-name list admits by default: every spelling
 * nobody thought to write down passes. A prefix refuses by default instead, so a member Postgres
 * adds next release is covered on the day it ships.
 *
 * Each family is a ban this file already makes in some other spelling:
 *  - reach outside the database — the original list (`pg_read_*`, `pg_ls_*`, `lo_*`, `dblink`);
 *  - hold a lock, which `FOR UPDATE` is refused for below. The call is the worse of the two: a
 *    SESSION advisory lock is not released by the `ROLLBACK` layer 2 always runs, so it outlives
 *    the read on a pooled connection the app's own writers use;
 *  - mutate the server or the session — `set_config` is `SET` spelled as a call, and `SET` is a
 *    write keyword above;
 *  - burn the wall clock — layer 2's `statement_timeout` cannot interrupt embedded PGlite
 *    (single-threaded WASM), which is the database `x dev` runs, so this ban is the only one
 *    that holds there.
 *
 * The prefix is applied to a CALL — a name followed by `(` — and never to a bare word, so a
 * column called `pg_sleep_for_seconds` stays readable. Quoting does not evade it: the scan reads
 * a form where a quoted identifier keeps its content, because `"pg_advisory_lock"(1)` is the same
 * call as `pg_advisory_lock(1)`.
 */
const FORBIDDEN_FUNCTIONS = [
  'dblink',
  'lo_',
  'pg_advisory_',
  'pg_cancel_backend',
  'pg_ls_',
  'pg_read_',
  'pg_sleep',
  'pg_stat_file',
  'pg_stat_reset',
  'pg_terminate_backend',
  'pg_try_advisory_',
  'set_config',
];

/** The family refusing `called`, or `undefined`. A prefix, so a new member is refused by default. */
function forbiddenFamily(called: string): string | undefined {
  return FORBIDDEN_FUNCTIONS.find((family) => called.startsWith(family));
}

/**
 * A call: an identifier immediately before `(`. Schema qualification falls out of the scan —
 * `pg_catalog.set_config(` matches on the last segment, which is the function being called.
 */
const CALL_PATTERN = /([a-z_][a-z0-9_$]*)\s*\(/g;

/** Every function `sql` calls, lowercased. Read from the identifier-preserving strip. */
function calledFunctions(sql: string): readonly string[] {
  const names: string[] = [];
  for (const match of sql.toLowerCase().matchAll(CALL_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Throw unless `sql` is a single read-only statement. Every check runs on the *stripped* form
 * (literals and comments blanked) so a keyword hiding in a string cannot fool it — but the
 * string returned is the caller's own `sql`, verbatim apart from surrounding whitespace and
 * one trailing `;`, because the caller *executes* this value. Returning the stripped form ran
 * `select 'delete from posts' as note` as `select   as note`.
 */
export function assertReadOnlyQuery(sql: string): string {
  const stripped = stripLiteralsAndComments(sql);
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length === 0) {
    throw rejected('the statement is empty', 'send one SELECT statement');
  }
  if (statements.length > 1) {
    throw rejected(
      `${statements.length} statements were sent; batching hides a write behind a read`,
      'send exactly one SELECT statement per db.query call',
    );
  }

  const statement = statements[0] ?? '';
  const words: readonly string[] = statement.toLowerCase().match(/[a-z_]+/g) ?? [];
  const leader = words[0] ?? '';
  if (!READ_LEADERS.has(leader)) {
    throw rejected(
      `statement begins with "${leader}", which is not a read`,
      `begin with one of: ${[...READ_LEADERS].sort().join(', ')}`,
    );
  }
  for (const word of words) {
    if (WRITE_KEYWORDS.has(word)) {
      throw rejected(
        `the statement contains the mutating keyword "${word}"`,
        // `db.migrate` applies pending migrations; it is not an INSERT/UPDATE/DELETE path, and
        // there is no MCP tool that is. Data changes go through an action, which carries a policy.
        'db.query has no write path: change data by calling an action exposed with ' +
          'mcp: { expose: true }, and change schema with db.migrate after x db branch <name>',
      );
    }
  }
  // A family refuses a CALL, never a bare word: scanning every word rejected a column named
  // `pg_sleep_for_seconds`, and scanning the blanked form missed `"pg_advisory_lock"(1)`, which
  // is the same call wearing quotes. So this pass reads the form that keeps identifier content.
  for (const called of calledFunctions(stripLiteralsAndComments(sql, 'keep'))) {
    const family = forbiddenFamily(called);
    if (family !== undefined) {
      // The cause names what the author wrote AND the family it belongs to: the second half is
      // the rule, and without it the next spelling looks like a different, arguable refusal.
      throw rejected(
        family === called
          ? `the statement calls ${called}(), which db.query may not call`
          : `the statement calls ${called}(), one of the ${family}* functions db.query may not call`,
        'query tables only: no file access, no locks, no session settings, no sleeps',
      );
    }
  }
  // `SELECT ... FOR UPDATE` takes row locks — a read that blocks other writers.
  if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(statement)) {
    throw rejected(
      'the statement takes row locks (FOR UPDATE/SHARE)',
      'drop the locking clause; db.query may not hold locks',
    );
  }
  return verbatim(sql);
}

/**
 * The caller's bytes, minus surrounding whitespace and one trailing `;`. Anything past that
 * semicolon is whitespace or a comment — the single-statement check above already proved the
 * stripped form has nothing else there.
 */
function verbatim(sql: string): string {
  const trimmed = sql.trim();
  return trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

/** What the host knows about the connection `db.migrate` would run against. */
export interface DatabaseTarget {
  /** Human-readable identity for the message. Never a connection string with a password. */
  readonly label: string;
  /** Branch name, or `null` when this is a shared/long-lived database. */
  readonly branch: string | null;
  /** True when this database backs production traffic. */
  readonly production: boolean;
}

/**
 * Throw unless `target` is a branch database. Two separate refusals so the message names
 * the actual problem: production is never migratable from MCP at all, and a non-production
 * shared database still is not a branch.
 */
export function assertBranchDatabase(target: DatabaseTarget): string {
  if (target.production) {
    throw notBranch(
      `"${target.label}" is a production database`,
      'run migrations in production through the migrate role: ROLE=migrate in your deploy hook',
    );
  }
  if (target.branch === null) {
    throw notBranch(
      `"${target.label}" is not a branch database`,
      'x db branch <name>, then retry db.migrate',
    );
  }
  return target.branch;
}

function rejected(cause: string, fix: string): McpQueryRejectedError {
  return new McpQueryRejectedError({ cause, fix });
}

function notBranch(cause: string, fix: string): McpNotBranchDbError {
  return new McpNotBranchDbError({ cause, fix });
}

/**
 * Replace string/identifier literals and comments with spaces so keyword scanning cannot be
 * fooled by `SELECT 'delete'` (a harmless literal that looks like a write) and cannot be
 * evaded by hiding a second statement behind a block comment. Only word boundaries matter
 * downstream, so collapsing each run to one space is enough.
 *
 * `identifiers: 'keep'` unwraps a double-quoted identifier to its content instead — the call
 * scan needs it, because `"pg_advisory_lock"(1)` calls the function the blanked form hides.
 * String and dollar-quoted literals are blanked in both modes: a literal is never a call.
 */
function stripLiteralsAndComments(sql: string, identifiers: 'blank' | 'keep' = 'blank'): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    const char = sql[i];
    if (char === "'" || char === '"') {
      const end = skipQuoted(sql, i, char);
      // Padded, never spliced in place: `select"pg_advisory_lock"(1)` must not fuse into one
      // token, or the call the quotes were hiding stays hidden behind the leading keyword.
      out += char === '"' && identifiers === 'keep' ? ` ${inner(sql.slice(i, end))} ` : ' ';
      i = end;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[a-z_]*\$/i.exec(sql.slice(i));
      if (tag !== null) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        i = end === -1 ? sql.length : end + marker.length;
        out += ' ';
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

/** A quoted run's content: the delimiters dropped, SQL's doubled-quote escape collapsed. */
function inner(run: string): string {
  const closed = run.length > 1 && run.endsWith(run[0] ?? '');
  return run.slice(1, closed ? -1 : undefined).replaceAll('""', '"');
}

/** Advance past a quoted run, honouring SQL's doubled-quote escape (`'it''s'`). */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}
