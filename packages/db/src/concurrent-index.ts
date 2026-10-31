// Single responsibility: what makes a migration NON-TRANSACTIONAL, and which of its statements are
// the concurrent index builds that need it. `create index concurrently` and `drop index
// concurrently` are refused inside a transaction block (`25001`), so the one marker line below is
// how a migration says "run me statement by statement, outside one" — read by `migration-step.ts`.

import { hasMarkerLine } from './marker-line';
import { IDENTIFIER_CHAR, noiseAt } from './sql-scan';
import { statementsOf } from './statement-split';

/**
 * The line a migration carries to run outside a transaction. Written into `up` by `x db gen` for
 * the step that holds every concurrent index build, and it governs BOTH halves of the file: the
 * `down` of a concurrent build is a concurrent drop, refused inside a transaction just the same.
 */
export const NO_TRANSACTION_MARKER = '-- transaction: false';

/** The whole comment, as `-- destructive: true` is matched: a mention declares nothing. */
const MARKER_COMMENT = /^--[ \t]*transaction:[ \t]*false[ \t]*\r?\n?$/i;

/** Whether this migration's `up` declares it runs outside a transaction. */
export const isNonTransactional = (up: string): boolean => hasMarkerLine(up, MARKER_COMMENT);

interface Token {
  readonly text: string;
  /** A word to compare, lower-cased — `undefined` for a quoted identifier or a punctuation mark. */
  readonly word: string | undefined;
}

const WHITESPACE = /\s/;

/**
 * The first `limit` tokens of one statement: comments skipped, a quoted identifier kept whole and
 * verbatim, a literal or dollar body ending the read — no statement this file recognises has one
 * before the name it is after. `sql-scan.ts` is the lexer, so a `"create"` is a name and not a verb.
 */
function leadingTokens(statement: string, limit: number): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < statement.length && tokens.length < limit) {
    const noise = noiseAt(statement, index);
    if (noise !== null) {
      if (noise.kind === 'string' || noise.kind === 'dollar-body') break;
      if (noise.kind === 'identifier') {
        tokens.push({ text: statement.slice(index, noise.end), word: undefined });
      }
      index = noise.end;
      continue;
    }
    const char = statement[index] ?? '';
    if (WHITESPACE.test(char)) {
      index += 1;
      continue;
    }
    let end = index + 1;
    if (IDENTIFIER_CHAR.test(char)) {
      while (end < statement.length && IDENTIFIER_CHAR.test(statement[end] ?? '')) end += 1;
    }
    const text = statement.slice(index, end);
    tokens.push({ text, word: IDENTIFIER_CHAR.test(char) ? text.toLowerCase() : undefined });
    index = end;
  }
  return tokens;
}

/**
 * The index a `create [unique] index concurrently [if not exists] <name>` builds, spelled exactly
 * as the statement spells it (`"runs_status_idx"`, `public.runs_status_idx`) — the text
 * `to_regclass()` resolves and `drop index concurrently if exists` accepts. `null` for every other
 * statement, and for an unnamed build: Postgres picks that name, so there is nothing to look up.
 */
export function concurrentIndexTarget(statement: string): string | null {
  const tokens = leadingTokens(statement, 12);
  const word = (at: number): string | undefined => tokens[at]?.word;
  let at = 0;
  if (word(at) !== 'create') return null;
  at += word(at + 1) === 'unique' ? 2 : 1;
  if (word(at) !== 'index' || word(at + 1) !== 'concurrently') return null;
  at += 2;
  if (word(at) === 'if' && word(at + 1) === 'not' && word(at + 2) === 'exists') at += 3;
  const name = tokens[at];
  if (name === undefined || name.word === 'on') return null;
  const dot = tokens[at + 1];
  const tail = tokens[at + 2];
  if (dot?.text === '.' && tail !== undefined) return `${name.text}.${tail.text}`;
  return name.text;
}

/**
 * Whether one statement is an index build or drop Postgres refuses inside a transaction block:
 * `create [unique] index concurrently`, `drop index concurrently`, `reindex … concurrently`.
 */
export function isConcurrentIndexStatement(statement: string): boolean {
  const words = leadingTokens(statement, 8).map((token) => token.word);
  const [first, second, third, fourth] = words;
  if (first === 'create') {
    return second === 'unique'
      ? third === 'index' && fourth === 'concurrently'
      : second === 'index' && third === 'concurrently';
  }
  if (first === 'drop') return second === 'index' && third === 'concurrently';
  return first === 'reindex' && words.includes('concurrently');
}

/** The first statement of `script` that cannot run inside a transaction, or `undefined`. */
export const firstConcurrentStatement = (script: string): string | undefined =>
  statementsOf(script).find(isConcurrentIndexStatement);
