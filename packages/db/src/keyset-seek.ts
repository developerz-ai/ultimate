// Single responsibility: the SQL `keyset()` splices for an order — each key's `order by` term and
// the seek past a cursor's position, NULL's place in both written down for a nullable key.
// The shapes mirror `entity/src/pg-sql.ts` (`seekSql`); db is tier 1 and cannot import it.

import { join, raw, type SqlFragment, sql } from './sql';

/** The kinds a position can be bound back as, each with its own cast. A closed list. */
export type KeysetKind = 'timestamptz' | 'uuid' | 'text' | 'integer' | 'bigint';

export interface KeysetKey {
  /** The ordered expression as written in the statement: `raw('p.created_at')`, or a `sql` one. */
  readonly column: SqlFragment;
  readonly kind: KeysetKind;
  readonly direction: 'asc' | 'desc';
  /** The key may be NULL on a row. Never the last key: the tiebreak must be not null. */
  readonly nullable?: true | undefined;
  /** NULL's place, nullable keys only. Default: `asc nulls last`, `desc nulls first`. */
  readonly nulls?: 'first' | 'last' | undefined;
}

/** One key of a cursor's position: the column's text, or `null` where the boundary row had none. */
export type KeysetPosition = readonly (string | null)[];

export const CASTS: ReadonlyMap<KeysetKind, string> = new Map<KeysetKind, string>([
  ['timestamptz', 'timestamptz'],
  ['uuid', 'uuid'],
  ['text', 'text'],
  ['integer', 'integer'],
  ['bigint', 'bigint'],
]);

/** Where a nullable key's NULLs sort — the same defaults as the entity driver and the query layer. */
export const nullsOf = (key: KeysetKey): 'first' | 'last' =>
  key.nulls ?? (key.direction === 'desc' ? 'first' : 'last');

const bind = (key: KeysetKey, text: string): SqlFragment =>
  sql`${text}::${raw(CASTS.get(key.kind) ?? 'text')}`;

/**
 * The splice re-derived from the closed set, as `entity/src/pg-sql.ts` does: never the caller's
 * text. A not-null key stays bare so an index on `(created_at desc, id desc)` still answers it.
 */
export const orderOf = (key: KeysetKey): SqlFragment => {
  const direction = key.direction === 'desc' ? 'desc' : 'asc';
  if (key.nullable !== true) return sql`${key.column} ${raw(direction)}`;
  return sql`${key.column} ${raw(`${direction} nulls ${nullsOf(key) === 'first' ? 'first' : 'last'}`)}`;
};

const past = (key: KeysetKey, value: SqlFragment): SqlFragment =>
  sql`${key.column} ${raw(key.direction === 'desc' ? '<' : '>')} ${value}`;

/**
 * What sorts strictly after the position on this one key, as alternatives. A value is followed by
 * the values past it, and by the NULLs too when they sort last. A NULL is followed by every value
 * when NULLs sort first, and by nothing when they sort last — the later keys carry that page.
 */
const after = (key: KeysetKey, value: string | null): SqlFragment[] => {
  const last = nullsOf(key) === 'last';
  if (value === null) return last ? [] : [sql`${key.column} is not null`];
  const beyond = past(key, bind(key, value));
  return key.nullable === true && last ? [beyond, sql`${key.column} is null`] : [beyond];
};

/** At the position on this key. `= $n` is never true of a NULL, so an absent one is `is null`. */
const equal = (key: KeysetKey, value: string | null): SqlFragment =>
  value === null ? sql`${key.column} is null` : sql`${key.column} = ${bind(key, value)}`;

/**
 * Uniform direction over not-null keys is ONE row comparison, the shape Postgres pushes into a
 * multicolumn index as an Index Cond. A mixed order, or any nullable key, has none (a row
 * comparison has no null order), so it is the or-chain — the same split as the entity driver's
 * `seekSql`. The last key is not null, so the chain always holds at least one term.
 */
export const seek = (keys: readonly KeysetKey[], position: KeysetPosition): SqlFragment => {
  const valueAt = (index: number): string | null => position[index] ?? null;
  const [first] = keys;
  if (first === undefined) return sql`true`;
  if (keys.length === 1) return past(first, bind(first, valueAt(0) ?? ''));
  const rowComparable = keys.every(
    (key) => key.direction === first.direction && key.nullable !== true,
  );
  if (rowComparable) {
    const op = raw(first.direction === 'desc' ? '<' : '>');
    const binds = keys.map((key, index) => bind(key, valueAt(index) ?? ''));
    return sql`(${join(keys.map((key) => key.column))}) ${op} (${join(binds)})`;
  }
  const terms = keys.flatMap((key, index) => {
    const prefix = keys.slice(0, index).map((prior, at) => equal(prior, valueAt(at)));
    return after(key, valueAt(index)).map((term) =>
      prefix.length === 0 ? term : sql`(${join([...prefix, term], ' and ')})`,
    );
  });
  return terms.length === 1 && terms[0] !== undefined ? terms[0] : sql`(${join(terms, ' or ')})`;
};
