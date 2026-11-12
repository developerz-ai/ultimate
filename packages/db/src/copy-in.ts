// Single responsibility: `COPY … FROM STDIN` on a `Bun.SQL` handle — the text-format line each row
// becomes, the stream that carries them, and the one test for whether a client can take a copy.
//
// Its own funnel beside `statement-funnel.ts` because a copy cannot go through `unsafe()`: Bun
// refuses an awaited COPY (`ERR_POSTGRES_COPY_NOT_SUPPORTED`), and `writable()` must be called
// before anything awaits the query.

import {
  assert,
  callerStack,
  describeValue,
  isUltimateError,
  renderThrowable,
} from '@ultimat3/core';
import { instantText, pgArrayLiteral } from './array-parameter';
import type { DbClient } from './client';
import { DbError, driverError } from './errors';
import type { SqlFragment } from './sql';
import { statementExcerpt } from './statement-excerpt';
import { traceStatement } from './statement-span';
import { transactionSettingsInstalled } from './transaction-settings';

/** A client that loads rows through `COPY … FROM STDIN`: `postgresClient()`, its pins and a `DbTx` on one. */
export interface CopyInClient {
  /**
   * `target` is `copy <table> (<columns>) from stdin` with nothing bound; each row is that column
   * list's values, in order, as a statement would bind them. One statement, so all or nothing.
   * Resolves with the rows the server stored.
   */
  copyIn(target: SqlFragment, rows: Iterable<readonly unknown[]>): Promise<number>;
}

/**
 * Whether `copyIn` is the right send, not merely present. Present on `postgresClient()`, its pins,
 * a `DbTx` opened on one and the replica router (which sends it to the primary); absent on PGlite
 * and a fake, which fall back to `insert` statements. And false whenever a row-security provider
 * is INSTALLED, whatever it answers now: Postgres refuses `COPY FROM` on a table under row-level
 * security (`0A000 COPY FROM not supported with row-level security`) even with no tenant in scope,
 * where the `insert` the caller falls back to is judged by the policy like any other write.
 */
export function canCopyIn(client: DbClient): client is DbClient & CopyInClient {
  return (
    typeof (client as Partial<CopyInClient>).copyIn === 'function' &&
    !transactionSettingsInstalled()
  );
}

/**
 * The four characters the text format reads as structure, and how each is spelled inside a cell.
 * Null-prototype: the key is a cell's own character, and no character may answer a prototype member.
 */
const ESCAPES: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
});
// Two regexes, not one: `test()` on a global regex advances `lastIndex`, and the next cell would be
// scanned from wherever the last one stopped.
const HAS_STRUCTURAL = /[\\\t\n\r]/;
const STRUCTURAL = /[\\\t\n\r]/g;

const escaped = (text: string): string =>
  HAS_STRUCTURAL.test(text) ? text.replace(STRUCTURAL, (char) => ESCAPES[char] ?? char) : text;

const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const cellUnsendable = (value: unknown): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `a COPY cell is ${describeValue(value)}, which has no text-format spelling`,
    fix: 'JSON.stringify(value)   # a jsonb cell, as its text; a scalar, a Date, a Uint8Array or an array binds as itself',
    meta: { received: describeValue(value) },
  });

/**
 * One cell as its column's input function reads it — the same value `encodeBoundParameters` would
 * send as a parameter, so a row copied and the row inserted are one row. `\N` is NULL; the word
 * `NULL` is text. Bytes double their backslash, because the text format reads `\x` as an escape.
 */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '\\N';
  if (typeof value === 'string') return escaped(value);
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (value instanceof Date) return instantText(value);
  if (value instanceof Uint8Array) return `\\\\x${hexOf(value)}`;
  if (Array.isArray(value)) return escaped(pgArrayLiteral(value));
  throw cellUnsendable(value);
};

/** One row of `COPY … FROM STDIN` in the text format: cells by tab, the row by newline. */
export function copyLine(cells: readonly unknown[]): string {
  let line = '';
  for (const [index, cell] of cells.entries())
    line += index === 0 ? cellText(cell) : `\t${cellText(cell)}`;
  return `${line}\n`;
}

/** One identifier as `identifier()` writes it — quoted, `""` for a quote — or a bare name. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`;
/**
 * The whole statement, anchored: `copy <ident>[.<ident>] (<ident>, …) from stdin` and nothing
 * else. A loose `from stdin` search passed `copy (select 1) to program 'id' -- from stdin`, and a
 * file path with `from stdin` inside a block comment after it. A `;` is refused anywhere, a quoted
 * name included: no entity's table or column holds one, and a second statement always does.
 */
const COPY_TARGET = new RegExp(
  String.raw`^copy\s+${IDENT}(?:\.${IDENT})?\s*\(\s*${IDENT}(?:\s*,\s*${IDENT})*\s*\)\s+from\s+stdin$`,
  'i',
);

const targetRefused = (text: string, why: string): DbError =>
  new DbError({
    code: 'X_SQL_UNSAFE',
    cause: `copyIn() takes a parameterless "copy <table> (<columns>) from stdin" — ${why}: ${statementExcerpt(text)}`,
    fix: 'copyIn(sql`copy <identifier(table)> (<join(columns.map(identifier))>) from stdin`, rows)   # values go in rows, never the statement',
  });

/** Before any send: a COPY binds nothing, so a value in the fragment could only be spliced. */
function refuseTarget(target: SqlFragment): void {
  if (target.values.length > 0) throw targetRefused(target.text, 'it binds a value');
  if (target.text.includes(';') || !COPY_TARGET.test(target.text.trim())) {
    throw targetRefused(target.text, 'it is not one COPY <table> (<columns>) FROM STDIN');
  }
}

/**
 * The caller's row source threw. Not the database's failure — `driverError` would call it
 * `X_DB_UNAVAILABLE`, and on a pin that marks the connection dead — so it is coded as the caller's.
 */
const rowsFailed = (target: SqlFragment, error: unknown): DbError =>
  new DbError({
    code: 'X_INVARIANT',
    cause: `copyIn()'s rows threw before the stream ended, so nothing was stored: ${renderThrowable(error)}`,
    fix: `copyIn(${statementExcerpt(target.text)}, rows)   # the row source threw: fix the throw above, which is its own, then call again`,
    sourceError: error,
  });

/** The next row, a throw from the caller's iterator coded as theirs. */
const nextRow = (
  target: SqlFragment,
  rows: Iterator<readonly unknown[]>,
): IteratorResult<readonly unknown[]> => {
  try {
    return rows.next();
  } catch (error) {
    throw rowsFailed(target, error);
  }
};

/** Bytes per write: large enough that a 100k-row copy is a few hundred writes, not 100k. */
const CHUNK_CHARS = 1 << 16;

/** `Bun.SQL`'s query as far as a copy reads it. */
interface CopyQuery extends PromiseLike<unknown> {
  readonly writable?: () => WritableStream<string>;
}

/** What a copy is sent on: the pool or one pinned connection. */
export interface CopySend {
  unsafe(text: string): unknown;
}

const countOf = (result: unknown): number => {
  const count = (result as { readonly count?: unknown } | null)?.count;
  return typeof count === 'number' ? count : 0;
};

async function stream(driver: CopySend, target: SqlFragment, rows: Iterable<readonly unknown[]>) {
  const query = driver.unsafe(target.text) as CopyQuery;
  assert(
    typeof query.writable === 'function',
    'this database driver answered a COPY with no writable() stream',
    'send the rows with insertAll(rows, { returning: false }) — canCopyIn(client) answers false for it',
  );
  // `writable()` FIRST: attaching a handler starts the query, after which Bun refuses the stream.
  const writer = query.writable().getWriter();
  const answered = Promise.resolve(query);
  answered.catch(() => undefined);
  try {
    let chunk = '';
    const source = rows[Symbol.iterator]();
    for (let next = nextRow(target, source); next.done !== true; next = nextRow(target, source)) {
      chunk += copyLine(next.value);
      if (chunk.length < CHUNK_CHARS) continue;
      await writer.write(chunk);
      chunk = '';
    }
    if (chunk.length > 0) await writer.write(chunk);
    await writer.close();
  } catch (error) {
    // Nothing of an aborted copy is stored, and the connection stays usable (Bun 1.4.4).
    await writer.abort(error).catch(() => undefined);
    // Our own refusal is already coded and names the cell; the server's is typed by its SQLSTATE.
    throw isUltimateError(error) ? error : driverError(statementExcerpt(target.text), error);
  }
  try {
    return countOf(await answered);
  } catch (error) {
    throw driverError(statementExcerpt(target.text), error);
  }
}

/** The copy funnel: one span and one `db.statement` event, like every statement the pool sends. */
export async function copyOn(
  driver: CopySend,
  target: SqlFragment,
  rows: Iterable<readonly unknown[]>,
): Promise<number> {
  refuseTarget(target);
  return traceStatement(
    target,
    () => stream(driver, target, rows),
    (count) => count,
    callerStack(),
  );
}
