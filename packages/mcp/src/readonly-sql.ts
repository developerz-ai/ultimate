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
  // `SELECT ... INTO <table>` is `CREATE TABLE AS` in another spelling: a DDL write with a read
  // leader, so nothing above catches it. The word, never the shape — `insert into` is already
  // refused by `insert`, and a bare `into` cannot appear in a read.
  'into',
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
 *    that holds there;
 *  - ADVANCE A SEQUENCE (`nextval`, `setval`) — a write that leaves no keyword behind, and one
 *    `ROLLBACK` does not undo: a consumed sequence value is gone, so a read can silently burn the
 *    next id a real insert would have taken. `currval`/`lastval` read the session and stay legal.
 *    `txid_current`/`pg_current_xact_id` are the same ban one level down: they ASSIGN a real
 *    transaction id to a read, and a rollback does not give it back;
 *  - PUBLISH A MESSAGE — `pg_notify` is `NOTIFY` spelled as a call, and `notify`, `listen` and
 *    `unlisten` are all write keywords above. The keyword scan cannot see it: it is one token;
 *  - CONTROL THE SERVER (`pg_reload_*`, `pg_rotate_*`, `pg_switch_*`, `pg_promote`,
 *    `pg_wal_replay_*`) — the family `pg_cancel_backend`/`pg_terminate_backend` already
 *    established, in the spellings that reconfigure or fail over the server rather than a backend;
 *  - CONSUME THE REPLICATION STREAM (`pg_create_*`, `pg_drop_*`, `pg_replication_*`,
 *    `pg_logical_*`) — `pg_logical_slot_get_changes` advances a slot's confirmed position, so the
 *    changes it returned are gone for the real consumer. Exactly the `nextval` argument: a write
 *    with no keyword, and no `ROLLBACK` undoes it. The catalog VIEWS beside them
 *    (`pg_replication_slots`, `pg_stat_replication`) are read `from`, never called, so the call
 *    scan never sees them;
 *  - WRITE A FILE (`pg_file_*`) — the other half of `pg_read_*`, which was banned from the start.
 *

 * The prefix is applied to a CALL — a name followed by `(` — and never to a bare word, so a
 * column called `pg_sleep_for_seconds` stays readable. Quoting does not evade it: the scan reads
 * a form where a quoted identifier keeps its content, because `"pg_advisory_lock"(1)` is the same
 * call as `pg_advisory_lock(1)`.
 */
const FORBIDDEN_FUNCTIONS = [
  'dblink',
  'lo_',
  'nextval',
  'pg_advisory_',
  'pg_cancel_backend',
  'pg_create_',
  'pg_current_xact_id',
  'pg_drop_',
  'pg_file_',
  'pg_logical_',
  'pg_ls_',
  'pg_notify',
  'pg_promote',
  'pg_read_',
  'pg_reload_',
  'pg_replication_',
  'pg_rotate_',
  'pg_sleep',
  'pg_stat_file',
  'pg_stat_reset',
  // Not reachable from `pg_stat_reset`: the extension spells the same reset with the statistics
  // view's name in the middle, so a prefix of one is not a prefix of the other.
  'pg_stat_statements_reset',
  'pg_switch_',
  'pg_terminate_backend',
  'pg_try_advisory_',
  'pg_wal_replay_',
  'set_config',
  'setval',
  'txid_current',
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
        // `create`, not the bare name: `x db branch` takes a VERB from a closed set, and the
        // bare form this used to hand out now resolves to nothing.
        'db.query has no write path: change data by calling an action exposed with ' +
          'mcp: { expose: true }, and change schema with db.migrate after x db branch create <name>',
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
      // The verb is load-bearing: `x db branch <name>` is now X_CLI_UNKNOWN_COMMAND, and before
      // the verbs existed it CREATED whatever word followed — including `ls`.
      //
      // The guidance rides behind `#`, never a comma: a fix line is pasted into a shell whole, and
      // `#` is the one joiner that leaves the command in front of it runnable. `<name>` stays a
      // placeholder — the branch name is the caller's to choose, which is why `@ultimat3/db` ships
      // this same line, same slot, in `branchNameInvalid`'s X_SQL_UNSAFE fix.
      'x db branch create <name>   # then retry db.migrate',
    );
  }
  return target.branch;
}

function rejected(cause: string, fix: string): McpQueryRejectedError {
  return new McpQueryRejectedError({ cause, fix });
}

/**
 * A delimiter that never closes: the scanner would blank everything after it, so the tail — `;`
 * and any write keyword in it — vanishes from every check below. `select '; delete from members`
 * counted one statement, contained no mutating word, and was handed back verbatim to run.
 *
 * Refused, not swallowed, for the same reason `\'` is: this layer's job is to refuse what it
 * cannot read. Postgres would answer a syntax error either way, and that is exactly the
 * dependency on the layer below that four defences exist not to have. Over-refusing costs a
 * malformed query a clearer message; under-refusing costs the guarantee.
 */
function unterminated(what: string, fix: string): McpQueryRejectedError {
  return rejected(`the statement ends inside ${what}, so the rest of it cannot be read`, fix);
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
      i = endOfLineComment(sql, i);
      out += ' ';
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        throw unterminated('a /* block comment', 'close it with */, or use -- to the end of line');
      }
      i = end + 2;
      out += ' ';
      continue;
    }
    const char = sql[i];
    if (char === "'" || char === '"') {
      const end = char === "'" ? skipSingleQuoted(sql, i) : skipQuoted(sql, i, char);
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
        if (end === -1) {
          throw unterminated(
            `a ${marker} dollar-quoted body`,
            `close it with the same tag: ${marker} … ${marker}`,
          );
        }
        i = end + marker.length;
        out += ' ';
        continue;
      }
    }
    out += char;
    i += 1;
  }
  return out;
}

/**
 * Where a `--` comment ends: the first CR **or** LF, or the end of the input.
 *
 * The boundary set is the lexer's, never one character of it. Postgres defines a line comment as
 * `--` followed by `non_newline*`, and `non_newline` is `[^\n\r]` — so a bare CR ends the comment
 * for the server. Scanning for `\n` alone blanked everything after a CR, and that tail is real SQL
 * the server runs: `select 1;--\rupdate members set role='admin'` was one statement with no
 * mutating keyword to every check in this file, and was handed back verbatim to be executed.
 * Same shape as `skipSingleQuoted` below, which reads Postgres' escape rules rather than one of them.
 */
function endOfLineComment(sql: string, start: number): number {
  for (let i = start + 2; i < sql.length; i += 1) {
    const char = sql[i];
    if (char === '\n' || char === '\r') return i;
  }
  return sql.length;
}

/** A quoted run's content: the delimiters dropped, SQL's doubled-quote escape collapsed. */
function inner(run: string): string {
  const closed = run.length > 1 && run.endsWith(run[0] ?? '');
  return run.slice(1, closed ? -1 : undefined).replaceAll('""', '"');
}

/**
 * Advance past a single-quoted run, and refuse the one sequence whose meaning this scanner cannot
 * decide: a backslash immediately before a quote.
 *
 * `E'\''` is ONE quote to Postgres — the backslash escapes it, the third quote closes the string —
 * so what follows is real statement text. A scanner that knows only the doubled-quote escape reads
 * the same bytes as a string that is still open, blanks the rest of the line, and counts one
 * statement: `select E'\'' ; drop table posts --'` was accepted and handed back verbatim to run.
 * Guessing the other way is no better, since `standard_conforming_strings` (a session setting this
 * tool cannot see) decides whether a PLAIN `'a\'` closes there. So the sequence is refused rather
 * than parsed under one of two readings — `''` embeds a quote under both.
 *
 * `\\` is consumed as a pair on purpose: both readings agree that `E'\\'` ends at that quote, so
 * refusing it would cost an ordinary read nothing is wrong with.
 */
function skipSingleQuoted(sql: string, start: number): number {
  let i = start + 1;
  while (i < sql.length) {
    const char = sql[i];
    if (char === '\\') {
      if (sql[i + 1] === "'") {
        throw rejected(
          String.raw`the statement contains \' inside a string literal, which ends the string ` +
            'under one Postgres setting and not the other',
          String.raw`double the quote instead of escaping it: 'it''s' rather than E'it\'s'`,
        );
      }
      i += 2;
      continue;
    }
    if (char === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  throw unterminated('a string literal', "close the quote, or double it to embed one: 'it''s'");
}

/** Advance past a quoted identifier, honouring SQL's doubled-quote escape (`"a""b"`). */
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
  throw unterminated('a quoted identifier', 'close the quote: select "column name" from posts');
}
