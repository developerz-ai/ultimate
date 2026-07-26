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
 * A quoted string literal. Postgres utility statements (`CREATE DATABASE`, `COMMENT ON`) reject
 * bound parameters, so this is the only place a value may be inlined — and it escapes quotes.
 * Never reach for it in a query: `sql` binds parameters there.
 */
export function literal(value: string): SqlFragment {
  return raw(`'${value.replaceAll("'", "''")}'`);
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
