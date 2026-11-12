// Single responsibility: what `contains` means on a `text()`/`char()` column — a case-insensitive
// substring, compiled to the bound `ilike` a `gin_trgm_ops` index serves and answered identically in
// memory. `contains` on `jsonb`/`arrayOf()` stays structural containment (`containment.ts`): the
// operator is decided by the column's declared kind, the rule `memory-match.ts` already reads.

import { type SqlFragment, sql } from '@ultimat3/db';
import type { ColumnKind } from './types';

/** The kinds whose `contains` is a substring. Every other kind keeps `@>`. */
const TEXT_KINDS: ReadonlySet<ColumnKind | undefined> = new Set<ColumnKind | undefined>([
  'text',
  'char',
]);

export const isTextContains = (kind: ColumnKind | undefined): boolean => TEXT_KINDS.has(kind);

/**
 * The term as an `ilike` pattern that finds it anywhere: the escape character first (so the
 * escapes added after it are not doubled), then both wildcards — a `%` typed into a search box is a
 * percent sign to find, never "anything". Postgres' default escape is the backslash, so no
 * `escape` clause is written and the planner still matches the trigram operator class.
 */
export const containsPattern = (term: string): string =>
  `%${term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;

/** Nothing matches: a non-text operand bound as its `String()` would find `"5"` or `"null"`. */
const NEVER = sql`1 = 0`;

/**
 * `col ilike $n`. `ilike` and not `lower(col) like lower($n)`: `gin_trgm_ops` serves `ilike` on the
 * bare column, while `lower(col)` is an expression no column index can match.
 */
export const textContainsSql = (column: SqlFragment, term: unknown): SqlFragment =>
  typeof term === 'string' ? sql`${column} ilike ${containsPattern(term)}` : NEVER;

/**
 * The memory driver's answer: both sides lower-cased, then a substring test — what the escaped
 * `ilike` pattern matches. Case folding is JS's Unicode `toLowerCase`; Postgres folds through the
 * database's collation, which agrees on every cased letter outside the locale-specific few
 * (Turkish dotted I).
 */
export const textContainsMatches = (actual: unknown, term: unknown): boolean =>
  typeof actual === 'string' &&
  typeof term === 'string' &&
  actual.toLowerCase().includes(term.toLowerCase());

/**
 * The `indexes:` entry that serves `contains` on `property` — `@ultimat3/db`'s spelling
 * (`index-key-ddl.ts`), so the plan sweep's `X_QUERY_UNINDEXED` fix names a declaration that
 * renders, and `x db gen` creates `pg_trgm` before it.
 */
export const trigramDeclaration = (property: string): string =>
  `indexes: [{ on: ['${property}'], using: 'gin', operatorClass: 'gin_trgm_ops' }]`;
