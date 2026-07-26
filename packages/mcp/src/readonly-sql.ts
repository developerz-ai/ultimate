// Enforcement for the dev server's two dangerous tools: `db.query` must be read-only and
// `db.migrate` must be pointed at a branch database.
//
// A description saying "read-only" is documentation; documentation is not a guarantee. The
// gate is structural: one statement, an allowed leading keyword, and no mutating keyword
// anywhere at statement level (which also catches a data-modifying CTE — `WITH x AS
// (INSERT ...) SELECT`, which reads like a SELECT and is not one).

import { McpReadOnlyViolationError } from './errors';

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

/** `pg_read_file`-class functions that read outside the database. */
const FORBIDDEN_FUNCTIONS = [
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_sleep',
  'lo_import',
  'lo_export',
  'dblink',
  'pg_terminate_backend',
  'pg_cancel_backend',
];

/**
 * Throw unless `sql` is a single read-only statement. Returns the normalised statement so
 * the caller logs what it actually ran, not what it was handed.
 */
export function assertReadOnlyQuery(sql: string): string {
  const stripped = stripLiteralsAndComments(sql);
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (statements.length === 0) {
    throw violation('db.query', 'the statement is empty', 'send one SELECT statement');
  }
  if (statements.length > 1) {
    throw violation(
      'db.query',
      `${statements.length} statements were sent; batching hides a write behind a read`,
      'send exactly one SELECT statement per db.query call',
    );
  }

  const statement = statements[0] ?? '';
  const words: readonly string[] = statement.toLowerCase().match(/[a-z_]+/g) ?? [];
  const leader = words[0] ?? '';
  if (!READ_LEADERS.has(leader)) {
    throw violation(
      'db.query',
      `statement begins with "${leader}", which is not a read`,
      `begin with one of: ${[...READ_LEADERS].sort().join(', ')}`,
    );
  }
  for (const word of words) {
    if (WRITE_KEYWORDS.has(word)) {
      throw violation(
        'db.query',
        `the statement contains the mutating keyword "${word}"`,
        'use db.migrate on a branch database for anything that writes',
      );
    }
  }
  // `SELECT ... FOR UPDATE` takes row locks — a read that blocks other writers.
  if (/\bfor\s+(update|no\s+key\s+update|share|key\s+share)\b/i.test(statement)) {
    throw violation(
      'db.query',
      'the statement takes row locks (FOR UPDATE/SHARE)',
      'drop the locking clause; db.query may not hold locks',
    );
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (words.includes(fn)) {
      throw violation(
        'db.query',
        `the statement calls ${fn}(), which reaches outside the database`,
        'query tables only',
      );
    }
  }
  return statement;
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
    throw violation(
      'db.migrate',
      `"${target.label}" is a production database`,
      'run migrations in production through the migrate role: ROLE=migrate in your deploy hook',
    );
  }
  if (target.branch === null) {
    throw violation(
      'db.migrate',
      `"${target.label}" is not a branch database`,
      'x db branch <name>, then retry db.migrate',
    );
  }
  return target.branch;
}

function violation(operation: string, cause: string, fix: string): McpReadOnlyViolationError {
  return new McpReadOnlyViolationError({ operation, cause, fix });
}

/**
 * Replace string/identifier literals and comments with spaces so keyword scanning cannot be
 * fooled by `SELECT 'delete'` (a harmless literal that looks like a write) and cannot be
 * evaded by hiding a second statement behind a block comment. Only word boundaries matter
 * downstream, so collapsing each run to one space is enough.
 */
function stripLiteralsAndComments(sql: string): string {
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
      i = skipQuoted(sql, i, char);
      out += ' ';
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
