// Single responsibility: the physical Postgres type a declared column KIND becomes. One table, so
// the statement that writes a column, the snapshot that records it and the pass that decides
// whether a retype is happening at all cannot disagree about what `char` means.
//
// Split out of `generate.ts` for `retype-keys.ts`, which has to answer "does this column's type
// move" ABOVE `diffTable` — a foreign key over a retyped column lives in another table's record.

const SQL_TYPES: Readonly<Record<string, string>> = {
  uuid: 'uuid',
  text: 'text',
  // Bare `char` is `char(1)` in Postgres, and the only column carrying this kind is money's
  // currency — a three-letter ISO 4217 code whose CHECK the entity emits on the same line.
  // Without the length no currency ever fits the constraint the same statement demands.
  char: 'char(3)',
  boolean: 'boolean',
  integer: 'integer',
  bigint: 'bigint',
  numeric: 'numeric',
  timestamptz: 'timestamptz',
  date: 'date',
  jsonb: 'jsonb',
};

/**
 * A kind this table does not name passes through verbatim — an app's own domain, an enum type a
 * hand-written migration created.
 *
 * `Object.hasOwn` and not a bare index: `kind` is DATA, so `SQL_TYPES['constructor']` answered the
 * `Object` function and `type ${wanted}` spliced its source into a statement, while `'__proto__'`
 * answered `[object Object]`. Guarded, both behave like every other unknown kind and pass through
 * as themselves. Measured across the package's 766 tests: no other input's answer moves.
 */
export function sqlType(kind: string): string {
  return Object.hasOwn(SQL_TYPES, kind) ? (SQL_TYPES[kind] ?? kind) : kind;
}
