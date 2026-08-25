// Single responsibility: decide whether a migration's `up` half destroys data, and whether the
// file admits it. The strong-migrations idea, enforced rather than documented — a drop is allowed,
// an *undeclared* drop is not. Only `up` is ever asked: reversing `create table` is `drop table`,
// so a rail reading `down` would mark every migration ever generated, and a mark on all is none.

import { stripSqlNoise } from './sql-noise';
import { noiseAt } from './sql-scan';
import { statementExcerpt } from './statement-excerpt';
import { statementsOf } from './statement-split';

/** The line a migration carries to declare that applying it destroys data. */
export const DESTRUCTIVE_MARKER = '-- destructive: true';

/**
 * The whole comment, so a file that merely *mentions* the marker — `-- destructive: true is
 * required for a drop` — has not declared anything. `\r` is allowed because an editor writing
 * CRLF must not turn a declared drop back into a gate failure.
 */
const MARKER_COMMENT = /^--[ \t]*destructive:[ \t]*true[ \t]*\r?\n?$/i;

/** Whether only spaces and tabs separate `index` from the start of its line. */
function startsLine(sql: string, index: number): boolean {
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = sql[at];
    if (char === '\n') return true;
    if (char !== ' ' && char !== '\t') return false;
  }
  return true;
}

/**
 * Declared only where a reader would see it: a top-level `--` line of its own.
 *
 * A regex over the raw file matched the marker inside `/* … *\/` and inside a dollar-quoted body,
 * where it declares nothing and no reviewer reading the diff would call it a declaration — yet it
 * bought the file past `x verify`. Scanning is what tells a comment from a comment about a
 * comment; the marker is a lexical fact, not a substring.
 */
export function hasDestructiveMarker(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const noise = noiseAt(sql, index);
    if (noise === null) {
      index += 1;
      continue;
    }
    const text = sql.slice(index, noise.end);
    if (noise.kind === 'line-comment' && startsLine(sql, index) && MARKER_COMMENT.test(text)) {
      return true;
    }
    index = noise.end;
  }
  return false;
}

export type DestructiveKind = 'drop-table' | 'drop-column' | 'retype-column' | 'truncate';

/** What each kind does to the rows, in the words `X_MIGRATION_DESTRUCTIVE` prints. */
export const DESTRUCTIVE_CAUSE: Readonly<Record<DestructiveKind, string>> = {
  'drop-table': 'drops a table',
  'drop-column': 'drops a column',
  'retype-column': 'rewrites a column to another type',
  truncate: 'truncates a table',
};

export interface DestructiveStatement {
  readonly kind: DestructiveKind;
  /** The statement as written, on one line, without the comments that preceded it. */
  readonly statement: string;
}

/**
 * The closed list. Four kinds, because a rail that tried to enumerate every Postgres foot-gun
 * would be a second SQL parser competing with the server's own — and every one of these is a
 * statement `generateMigration` can emit, so each has a generated case to hold it honest.
 *
 * First match wins: one statement is one operation, and a second finding on the same line would
 * repeat an instruction that is already one marker for the whole file.
 */
const RULES: readonly (readonly [DestructiveKind, RegExp])[] = [
  ['drop-table', /\bdrop\s+(?:foreign\s+)?table\b/],
  ['truncate', /\btruncate\b/],
  // Inside an `alter table`, a bare `drop <name>` is a column: every sub-clause that drops
  // something the database can rebuild names itself, and all of them are listed here.
  [
    'drop-column',
    /\balter\s+table\b[\s\S]*?\bdrop\s+(?!constraint\b|default\b|not\b|identity\b|expression\b|generated\b)/,
  ],
  // Not "narrowing". Whether the new type is narrower is knowable only against the old one, and a
  // rewrite that fails on one row fails the whole migration whichever direction it went.
  ['retype-column', /\balter\s+column\b[\s\S]*?\btype\b/],
];

/**
 * Every destructive statement in `up`, in apply order.
 *
 * `statementsOf` cuts on a `;` that is not inside a literal, an identifier, a dollar-quoted body
 * or a comment, and `stripSqlNoise` blanks all four before a keyword is looked for — so
 * `-- drop table users` and `insert into audit values ('drop table users')` are prose and data,
 * not operations. A naive keyword scan reports both, which is how a rail earns being ignored.
 */
export function destructiveStatements(up: string): readonly DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  for (const statement of statementsOf(up)) {
    const bare = stripSqlNoise(statement).toLowerCase();
    const rule = RULES.find(([, pattern]) => pattern.test(bare));
    if (rule !== undefined) found.push({ kind: rule[0], statement: statementExcerpt(statement) });
  }
  return found;
}

/** Whether `up` destroys data at all — what `x db gen` writes the marker from. */
export const isDestructive = (up: string): boolean => destructiveStatements(up).length > 0;
