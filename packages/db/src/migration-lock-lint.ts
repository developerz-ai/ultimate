// Single responsibility: decide whether a hand-written migration's `up` holds a live table still for
// a full scan — `set not null` with no validated check before it, or a non-concurrent index build —
// and raise `X_MIGRATION_LOCK_HEAVY` for it. `rolling.ts`'s shape and token stream: lexical, `up`
// only, a closed list, a marker to admit a deliberate one.

import { renderFixShellArg } from '@ultimat3/core';
import { NO_TRANSACTION_MARKER } from './concurrent-index';
import { DbError } from './errors';
import { hasMarkerLine } from './marker-line';
import { alteredTable, isWord, nameOf, qualifiedNameAt, subcommands, tokensOf } from './rolling';
import { statementExcerpt } from './statement-excerpt';
import { statementsOf } from './statement-split';

/** The line a migration carries when the lock is deliberate: a small table, a maintenance window. */
export const LOCK_HEAVY_MARKER = '-- lock-heavy: true';

const LOCK_HEAVY_COMMENT = /^--[ \t]*lock-heavy:[ \t]*true[ \t]*\r?\n?$/i;

/** The comments and blank space `statementsOf` carries in front of a statement's SQL. */
const LEADING_NOISE = /^(?:\s*(?:--[^\n]*|\/\*[\s\S]*?\*\/)\s*)+/;

/** Only spaces and tabs between `at` and the start of its line in `up` (or the file's start). */
function startsLine(up: string, at: number): boolean {
  for (let index = at - 1; index >= 0; index -= 1) {
    if (up[index] === '\n') return true;
    if (up[index] !== ' ' && up[index] !== '\t') return false;
  }
  return true;
}

/**
 * Whether the line directly above the statement's first SQL line is the marker, as a line of its
 * own (`hasMarkerLine`). `at` is where the trimmed `statement` starts in `up`: a marker that is the
 * statement's first line must start its line there too, or it trails the previous statement.
 */
function markedAbove(up: string, statement: string, at: number): boolean {
  const lines = (LEADING_NOISE.exec(statement)?.[0] ?? '').split('\n');
  // The SQL must open its own line: `*/ create …` puts the line above inside the comment.
  if (lines.length < 2 || (lines.at(-1) ?? '').trim() !== '') return false;
  const above = lines.length - 2;
  if (above === 0 && !startsLine(up, at)) return false;
  return hasMarkerLine(`${lines[above] ?? ''}\n`, LOCK_HEAVY_COMMENT);
}

/**
 * The migration id the rail judges after, exclusive: the release that shipped it. An applied
 * migration cannot gain a marker (its checksum covers it), so judging history would turn an
 * existing app red with no fix but rewriting it. The comparison `rollingSince` makes, with the
 * bound fixed by the framework rather than opted into, since every app's next file can comply.
 */
export const LOCK_HEAVY_SINCE = '20261113000000';

export const lockHeavyJudged = (id: string): boolean => id > LOCK_HEAVY_SINCE;

/** The closed list. Every other lock is either the generator's or too rare to earn a parser. */
export type LockHeavyKind = 'set-not-null' | 'create-index';

export interface LockHeavyStatement {
  readonly kind: LockHeavyKind;
  readonly table: string;
  /** The column `set not null` names; `null` for an index build. */
  readonly column: string | null;
  /** The statement as written, on one line. */
  readonly statement: string;
}

/**
 * `create [temp|temporary|unlogged|materialized] table|view [if not exists] [schema.]t`: the
 * relation no reader has yet, or none. A materialized view is here because `generate-view.ts`
 * rebuilds one by drop + create and indexes it in the same file.
 */
function createdTable(tokens: readonly string[]): string | undefined {
  if (!isWord(tokens[0], 'create')) return undefined;
  let at = 1;
  if (['temp', 'temporary', 'unlogged'].some((word) => isWord(tokens[at], word))) at += 1;
  if (isWord(tokens[at], 'materialized') && isWord(tokens[at + 1], 'view')) at += 1;
  else if (!isWord(tokens[at], 'table')) return undefined;
  at += 1;
  if (isWord(tokens[at], 'if') && isWord(tokens[at + 1], 'not') && isWord(tokens[at + 2], 'exists'))
    at += 3;
  return qualifiedNameAt(tokens, at)?.name;
}

/**
 * `create [unique] index …` without `concurrently` and not `on only`: the table it locks. `on only`
 * builds an invalid index on a partitioned parent's own (empty) relation, the first of the
 * concurrent partitioned form, so it scans nothing.
 */
function blockingIndexTable(tokens: readonly string[]): string | undefined {
  if (!isWord(tokens[0], 'create')) return undefined;
  const at = isWord(tokens[1], 'unique') ? 2 : 1;
  if (!isWord(tokens[at], 'index') || isWord(tokens[at + 1], 'concurrently')) return undefined;
  const on = tokens.findIndex((token, index) => index > at && isWord(token, 'on'));
  if (on < 0 || isWord(tokens[on + 1], 'only')) return undefined;
  return qualifiedNameAt(tokens, on + 1)?.name;
}

/** `alter [column] c set not null`: the column, or none. */
function setNotNullColumn(part: readonly string[]): string | undefined {
  if (!isWord(part[0], 'alter')) return undefined;
  const at = isWord(part[1], 'column') ? 2 : 1;
  const [name, set, not, nul] = part.slice(at, at + 4);
  if (name === undefined || !isWord(set, 'set') || !isWord(not, 'not') || !isWord(nul, 'null'))
    return undefined;
  return nameOf(name);
}

/**
 * Every statement in `up` that scans a table it did not create under a lock that stops writes, in
 * apply order. A table created earlier in the same `up` has no rows yet. A `validate constraint` on
 * the table earlier in the same `up` is the two-step form's second half: Postgres 12+ proves NOT
 * NULL from a validated `check (c is not null)` and skips the scan. A statement with the marker on
 * the line directly above it is admitted — that statement only, never the file.
 */
export function lockHeavyStatements(up: string): readonly LockHeavyStatement[] {
  const found: LockHeavyStatement[] = [];
  const created = new Set<string>();
  const validated = new Set<string>();
  let cursor = 0;
  for (const statement of statementsOf(up)) {
    const at = up.indexOf(statement, cursor);
    cursor = at < 0 ? cursor : at + statement.length;
    const admitted = at >= 0 && markedAbove(up, statement, at);
    const tokens = tokensOf(statement);
    const table = createdTable(tokens);
    if (table !== undefined) created.add(table);
    const indexed = blockingIndexTable(tokens);
    if (indexed !== undefined && !created.has(indexed) && !admitted) {
      found.push({
        kind: 'create-index',
        table: indexed,
        column: null,
        statement: statementExcerpt(statement),
      });
    }
    const altered = alteredTable(tokens);
    if (altered === undefined) continue;
    for (const part of subcommands(tokens.slice(altered.next))) {
      if (isWord(part[0], 'validate')) validated.add(altered.table);
      const column = setNotNullColumn(part);
      if (
        column === undefined ||
        admitted ||
        created.has(altered.table) ||
        validated.has(altered.table)
      )
        continue;
      found.push({
        kind: 'set-not-null',
        table: altered.table,
        column,
        statement: statementExcerpt(statement),
      });
    }
  }
  return found;
}

const STATED: Readonly<Record<LockHeavyKind, string>> = {
  'set-not-null': 'sets a column not null with no validated check before it',
  'create-index': 'builds an index without concurrently',
};

/** The two-step form for the kind, then the marker for a lock that is deliberate. */
function twoSteps(first: LockHeavyStatement): string {
  const table = renderFixShellArg(first.table, '<table>');
  if (first.kind === 'create-index')
    return `create index concurrently … on "${table}" (…);   # in a migration of its own whose first line is "${NO_TRANSACTION_MARKER}" — x db gen writes it so for an index whose entity does not say concurrently: false`;
  const column = renderFixShellArg(first.column ?? '<column>', '<column>');
  const check = `${table}_${column}_not_null`;
  return (
    `alter table "${table}" add constraint "${check}" check ("${column}" is not null) not valid;   # ` +
    `deploy, then a new migration: alter table "${table}" validate constraint "${check}"; alter table "${table}" alter column "${column}" set not null; alter table "${table}" drop constraint "${check}";`
  );
}

/** The gate's finding over a committed file. One per migration, as `migrationRollingUnsafe` is. */
export const migrationLockHeavy = (file: string, first: LockHeavyStatement, more = 0): DbError =>
  new DbError({
    code: 'X_MIGRATION_LOCK_HEAVY',
    cause: `${file} ${STATED[first.kind]}, so "${first.table}" stops taking writes for a full scan${more === 0 ? '' : ` (and ${more} more)`}: ${first.statement}`,
    fix: `${twoSteps(first)} — a deliberate one: add the line "${LOCK_HEAVY_MARKER}" directly above that statement in ${file} before it is applied — it admits that statement only`,
    meta: { file, kind: first.kind, table: first.table, column: first.column },
  });
