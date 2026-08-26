// Single responsibility: build parameterised SQL. String interpolation is how every SQL
// injection ships, and an agent writing SQL cannot be trusted to remember the difference
// between a value and a fragment — so the tag binds scalars to `$1..$n` and refuses anything
// else outright. `raw()` is the one audited escape hatch, and it is visible in review.

import { identifierUnsafe, sqlUnsafe } from './errors';

export interface SqlFragment {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** Only fragments carrying this brand may be spliced into another fragment. */
const SQL_BRAND: unique symbol = Symbol.for('ultimate.db.sql');

interface Compiled extends SqlFragment {
  readonly [SQL_BRAND]: 'sql' | 'raw';
  /**
   * `chunks.length === values.length + 1`. Keeping the pre-split parts means nesting
   * renumbers parameters by rebuilding, never by re-parsing `$n` out of `.text` — which
   * would corrupt a `raw()` fragment that legitimately contains a `$` token.
   */
  readonly chunks: readonly string[];
}

export function isSqlFragment(value: unknown): value is SqlFragment {
  return typeof value === 'object' && value !== null && SQL_BRAND in value;
}

const SCALAR_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'undefined']);

/** What Postgres can accept as a bound parameter. Everything else is a programming error. */
function isBoundValue(value: unknown): boolean {
  if (value === null) return true;
  if (SCALAR_TYPES.has(typeof value)) return true;
  if (value instanceof Date) return true;
  if (value instanceof Uint8Array) return true;
  if (Array.isArray(value)) return value.every(isBoundValue);
  return false;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array containing a non-scalar';
  if (typeof value === 'object' && 'text' in (value as Record<string, unknown>)) {
    return 'an object shaped like a SqlFragment but not produced by sql`` or raw()';
  }
  return `a ${typeof value}`;
}

function render(chunks: readonly string[]): string {
  let text = chunks[0] ?? '';
  for (let index = 1; index < chunks.length; index += 1) {
    text += `$${index}${chunks[index] ?? ''}`;
  }
  return text;
}

function compile(chunks: readonly string[], values: readonly unknown[]): Compiled {
  return {
    [SQL_BRAND]: 'sql',
    chunks,
    values,
    text: render(chunks),
  };
}

/** Accumulates chunks/values so appending a fragment is a splice, not a string rewrite. */
class Builder {
  private readonly chunks: string[] = [''];
  private readonly values: unknown[] = [];

  text(part: string): void {
    this.chunks[this.chunks.length - 1] = `${this.chunks[this.chunks.length - 1] ?? ''}${part}`;
  }

  value(value: unknown): void {
    this.values.push(value === undefined ? null : value);
    this.chunks.push('');
  }

  fragment(nested: Compiled): void {
    this.text(nested.chunks[0] ?? '');
    for (let index = 1; index < nested.chunks.length; index += 1) {
      this.value(nested.values[index - 1]);
      this.text(nested.chunks[index] ?? '');
    }
  }

  done(): Compiled {
    return compile([...this.chunks], [...this.values]);
  }
}

export function sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlFragment {
  const builder = new Builder();
  builder.text(strings[0] ?? '');
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (isSqlFragment(value)) builder.fragment(value as Compiled);
    else if (isBoundValue(value)) builder.value(value);
    else throw sqlUnsafe(describe(value), index + 1);
    builder.text(strings[index + 1] ?? '');
  }
  return builder.done();
}

/**
 * Mark a string as trusted SQL. Every call is an audit point: the argument must never be
 * derived from a request, a row, or an LLM completion.
 */
export function raw(trusted: string): SqlFragment {
  const fragment: Compiled = {
    [SQL_BRAND]: 'raw',
    chunks: [trusted],
    values: [],
    text: trusted,
  };
  return fragment;
}

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * A quoted identifier — the safe answer to the `raw()` temptation. Table and column names
 * cannot be bound as parameters, so they are validated and double-quoted instead.
 */
export function identifier(name: string): SqlFragment {
  if (SAFE_IDENTIFIER.test(name)) return raw(`"${name}"`);
  if (name.length === 0 || /[\s"\\]/.test(name)) throw identifierUnsafe(name);
  return raw(`"${name}"`);
}

/**
 * A quoted string literal Postgres reads IDENTICALLY under both settings of
 * `standard_conforming_strings`. Utility and DDL statements (`CREATE DATABASE`, `COMMENT ON`,
 * `create table … default …`) reject bound parameters, so this is the only place a value may be
 * inlined. Never reach for it in a query: `sql` binds parameters there.
 *
 * **It DOES receive caller input, and this comment said otherwise until 2026-08-25.**
 * `column-default.ts:43` renders `ColumnDefaultLike` here, which is an app's own
 * `.default('C:\\logs')` crossing the tier seam from `@ultimat3/entity` — nothing validates it and
 * no `identifier()` guards it. (The package's two other callers are safe by CONSTRUCTION, not by
 * input: `readonly-role.ts:71` sits in the same `sql` template as an `identifier(role)` that throws
 * first, and `branch.ts:85` runs after an already-awaited `identifier(base)`.)
 *
 * Doubling the quote is not the whole rule. That GUC is settable per session, per database and per
 * role and `SET` needs no privilege, and with it `off` a backslash escapes the character after it
 * inside an ordinary `'…'`. Measured on 18.4 through `generateMigration`: `.default('C:\\logs')`
 * emits `default 'C:\logs'`, which stores `C:\logs` with the GUC on and **`C:logs`** with it off —
 * a column defaulting to a value nobody wrote, with no error anywhere. A value ENDING in a
 * backslash is worse than wrong: the escaped quote leaves the literal unterminated and the text
 * after it is string data until the next `'` puts the remainder back into code position.
 *
 * `E'…'` fixes the dialect in the text itself rather than trusting a setting, so both readings
 * agree — **only** when the value actually carries a backslash. Without one there is no escape
 * mechanism for the two settings to disagree about, so every migration already generated stays byte
 * for byte what it was and nothing regenerates spuriously; both tracked apps have applied
 * migrations on disk with hashes over this text. Same rule, same measurement, as
 * `packages/entity/src/sql-literal.ts`, which is where it was first written and which adopts this
 * one — tier 1 holds it, tier 2 imports down.
 */
export function literal(value: string): SqlFragment {
  const quoted = value.replaceAll("'", "''");
  return raw(value.includes('\\') ? `E'${quoted.replaceAll('\\', '\\\\')}'` : `'${quoted}'`);
}

/** `a, b, c` — the one blessed way to build an IN list or a column list. */
export function join(fragments: readonly SqlFragment[], separator = ', '): SqlFragment {
  const builder = new Builder();
  fragments.forEach((fragment, index) => {
    if (!isSqlFragment(fragment)) throw sqlUnsafe(describe(fragment), index + 1);
    if (index > 0) builder.text(separator);
    builder.fragment(fragment as Compiled);
  });
  return builder.done();
}
