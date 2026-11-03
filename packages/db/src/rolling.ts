// Single responsibility: decide whether a migration's `up` would break the pods still running the
// old release, and read the markers that say a drop took two releases. `destructive.ts`'s shape,
// and the same path: `statementsOf`, then lexical. A rolling deploy runs N and N-1 at once, and N-1
// names every column it declares in every statement, so a drop before it is gone is an outage.

import { REBUILDABLE_DROP_CLAUSES } from './destructive';
import { markerLines } from './marker-line';
import { noiseAt } from './sql-scan';
import { statementExcerpt } from './statement-excerpt';
import { statementsOf } from './statement-split';

/** The line a migration carries when one instance stops before the next starts. */
export const ROLLING_UNSAFE_MARKER = '-- rolling-unsafe: true';

const ROLLING_UNSAFE_COMMENT = /^--[ \t]*rolling-unsafe:[ \t]*true[ \t]*\r?\n?$/i;

export const hasRollingUnsafeMarker = (sql: string): boolean =>
  markerLines(sql, ROLLING_UNSAFE_COMMENT).length > 0;

/**
 * Spelled through `identifier()` by every writer (`retired.ts`), so the comment holds no newline and
 * no second quote for a reader to trip on, and this one reads back exactly what was written.
 */
const quotedPair = (table: string, column: string): string => `"${table}"."${column}"`;
export const retiresMarker = (table: string, column: string): string =>
  `-- retires ${quotedPair(table, column)}`;
export const contractsMarker = (table: string, column: string): string =>
  `-- contracts ${quotedPair(table, column)}`;
export const unretiresMarker = (table: string, column: string): string =>
  `-- unretires ${quotedPair(table, column)}`;

const namedBy = (verb: string): RegExp =>
  new RegExp(`^--[ \\t]*${verb}[ \\t]+"([^"]+)"\\."([^"]+)"[ \\t]*\\r?\\n?$`, 'i');

const RETIRES = namedBy('retires');
const CONTRACTS = namedBy('contracts');
const UNRETIRES = namedBy('unretires');

/** One column as one string, for a set: compared, never parsed, and no two pairs share one. */
export const columnKey = (table: string, column: string): string => JSON.stringify([table, column]);

interface NamedColumn {
  readonly table: string;
  readonly column: string;
}

function columnsNamedBy(sql: string, marker: RegExp): readonly NamedColumn[] {
  return markerLines(sql, marker).flatMap((line) => {
    const match = marker.exec(line);
    const [table, column] = [match?.[1], match?.[2]];
    return table === undefined || column === undefined ? [] : [{ table, column }];
  });
}

/** The columns this `up` declares retired, as `columnKey`. */
export const retiredColumnsIn = (up: string): readonly string[] =>
  columnsNamedBy(up, RETIRES).map(({ table, column }) => columnKey(table, column));

/** The columns this `up` takes back: a retire before it earns no later drop. */
export const unretiredColumnsIn = (up: string): readonly string[] =>
  columnsNamedBy(up, UNRETIRES).map(({ table, column }) => columnKey(table, column));

/** The closed list. A rail that tried every Postgres foot-gun would be a second SQL parser. */
export type RollingUnsafeKind = 'drop-column' | 'rename-column' | 'rename-table';

export interface RollingUnsafeStatement {
  readonly kind: RollingUnsafeKind;
  readonly table: string;
  /** The column, or the table's old name for `rename-table`, which has no column. */
  readonly column: string | null;
  /** The statement as written, on one line. */
  readonly statement: string;
}

/**
 * Words, quoted identifiers and punctuation, with comments, literals and dollar bodies gone. Why
 * not `stripSqlNoise`, which `destructive.ts` reads: it blanks a quoted identifier too, and this
 * rail has to say WHICH column.
 */
function tokensOf(statement: string): readonly string[] {
  let text = '';
  let index = 0;
  while (index < statement.length) {
    const noise = noiseAt(statement, index);
    if (noise === null) {
      text += statement[index];
      index += 1;
      continue;
    }
    if (noise.kind === 'identifier') text += statement.slice(index, noise.end);
    else text += noise.kind.endsWith('comment') ? ' ' : " '' ";
    index = noise.end;
  }
  return text.match(/"(?:[^"]|"")*"|[A-Za-z_][\w$]*|\S/g) ?? [];
}

const isWord = (lexeme: string | undefined, word: string): boolean =>
  lexeme !== undefined && !lexeme.startsWith('"') && lexeme.toLowerCase() === word;

/** What Postgres folds a token to: a quoted one keeps its case, a bare one lowers. */
const nameOf = (token: string): string =>
  token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase();

/** `alter table [if exists] [only] [schema.]t`, as the table and where its subcommands start. */
function alteredTable(tokens: readonly string[]): { table: string; next: number } | undefined {
  if (!isWord(tokens[0], 'alter') || !isWord(tokens[1], 'table')) return undefined;
  let at = 2;
  if (isWord(tokens[at], 'if') && isWord(tokens[at + 1], 'exists')) at += 2;
  if (isWord(tokens[at], 'only')) at += 1;
  let name = tokens[at];
  at += 1;
  while (tokens[at] === '.') {
    name = tokens[at + 1];
    at += 2;
  }
  return name === undefined ? undefined : { table: nameOf(name), next: at };
}

/** Top-level commas only: `add constraint … (a, b)` is one subcommand. */
function subcommands(tokens: readonly string[]): readonly (readonly string[])[] {
  const parts: string[][] = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (token === '(') depth += 1;
    if (token === ')') depth -= 1;
    if (token === ',' && depth === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  }
  return parts;
}

function judged(
  table: string,
  part: readonly string[],
): { readonly kind: RollingUnsafeKind; readonly column: string | null } | undefined {
  const [verb, second] = part;
  if (isWord(verb, 'drop')) {
    if (second === undefined || REBUILDABLE_DROP_CLAUSES.includes(second.toLowerCase()))
      return undefined;
    let at = isWord(second, 'column') ? 2 : 1;
    if (isWord(part[at], 'if') && isWord(part[at + 1], 'exists')) at += 2;
    const name = part[at];
    return name === undefined ? undefined : { kind: 'drop-column', column: nameOf(name) };
  }
  if (!isWord(verb, 'rename') || second === undefined) return undefined;
  if (isWord(second, 'to')) return { kind: 'rename-table', column: table };
  if (isWord(second, 'constraint')) return undefined;
  const name = isWord(second, 'column') ? part[2] : second;
  return name === undefined ? undefined : { kind: 'rename-column', column: nameOf(name) };
}

/**
 * Every statement in `up` a pod of the previous release would still trip over, in apply order.
 *
 * `retired` holds the columns an EARLIER migration marked, as `columnKey`: a drop of one of those
 * is what the two-release path is for. A retire in the same file is not earlier, since one deploy
 * would apply both. Only `up`, the rule `destructive.ts` states.
 */
export function rollingUnsafeStatements(
  up: string,
  retired: ReadonlySet<string> = new Set(),
): readonly RollingUnsafeStatement[] {
  const found: RollingUnsafeStatement[] = [];
  for (const statement of statementsOf(up)) {
    const tokens = tokensOf(statement);
    const altered = alteredTable(tokens);
    if (altered === undefined) continue;
    for (const part of subcommands(tokens.slice(altered.next))) {
      const verdict = judged(altered.table, part);
      if (verdict === undefined) continue;
      if (
        verdict.kind === 'drop-column' &&
        verdict.column !== null &&
        retired.has(columnKey(altered.table, verdict.column))
      ) {
        continue;
      }
      found.push({
        kind: verdict.kind,
        table: altered.table,
        column: verdict.column,
        statement: statementExcerpt(statement),
      });
    }
  }
  return found;
}

export interface RetireAndContract {
  readonly table: string;
  readonly column: string;
  readonly retire: string;
  readonly contract: string;
}

/**
 * The pair the static rail cannot see: both written properly in separate migrations, and both about
 * to land in one deploy, where old pods meet the drop anyway. The first such pair, or `undefined`.
 */
export function retireAndContractPending(
  pending: readonly { readonly id: string; readonly up: string }[],
): RetireAndContract | undefined {
  const retires = new Map<string, string>();
  for (const migration of pending) {
    for (const { table, column } of columnsNamedBy(migration.up, CONTRACTS)) {
      const retire = retires.get(columnKey(table, column));
      if (retire !== undefined) return { table, column, retire, contract: migration.id };
    }
    for (const key of retiredColumnsIn(migration.up)) retires.set(key, migration.id);
  }
  return undefined;
}
