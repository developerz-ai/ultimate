// The full-text search vector an entity DERIVES from its `.searchable()` columns: one generated
// `tsvector` column, one language, one weight per source. Everything spliced into the expression
// here comes from a closed set or from a physical column name `assertColumnName` already checked —
// a search TERM never reaches this file, because a term is bound as a parameter (`pg-sql.ts`).

import type { SearchWeight } from './types';

/**
 * Postgres' own default text search configurations, as `\dF` lists them on 13 and later. A CLOSED
 * set because the configuration is the one part of `to_tsvector(config, text)` that cannot be a
 * bound parameter inside a generated column — it is spliced — so it may only ever be a value this
 * file already contains. A server without one of these answers `3F000` at `create table`, which is
 * loud and lands on the author, not on a search.
 */
export const SEARCH_LANGUAGES = [
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'simple',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
] as const;

export type SearchLanguage = (typeof SEARCH_LANGUAGES)[number];

/** The one membership test. `includes` on the tuple, never a computed read of a table. */
export const isSearchLanguage = (value: unknown): value is SearchLanguage =>
  typeof value === 'string' && (SEARCH_LANGUAGES as readonly string[]).includes(value);

export const SEARCH_WEIGHTS = ['A', 'B', 'C', 'D'] as const;

export const isSearchWeight = (value: unknown): value is SearchWeight =>
  typeof value === 'string' && (SEARCH_WEIGHTS as readonly string[]).includes(value);

/** Postgres' own default weight, so an unweighted source ranks exactly as an unweighted vector. */
export const DEFAULT_SEARCH_WEIGHT: SearchWeight = 'D';

export const DEFAULT_SEARCH_LANGUAGE: SearchLanguage = 'english';

export const DEFAULT_SEARCH_COLUMN = 'search_tsv';

/**
 * What a `matches` predicate names instead of a column. `$`-prefixed for the reason every member
 * of `EntityCore` is: `assertColumnName` requires `[a-z_]` first, so no declared column can ever
 * be spelled this, and a `matches` predicate can therefore never be confused with one on a real
 * column. Nothing resolves it through `physicalName` — both drivers branch on the OPERATOR.
 */
export const SEARCH_PROPERTY = '$search';

export interface SearchSource {
  /** Physical column, already through `assertColumnName`. */
  readonly column: string;
  readonly weight: SearchWeight;
}

/** How an entity's search is declared, when the defaults do not fit the table it adopted. */
export interface SearchInit {
  /** The physical vector column, when `search_tsv` is taken or the table already named one. */
  readonly column?: string;
  readonly language?: SearchLanguage;
}

export interface SearchVector {
  /** The physical `tsvector` column. Never a row property. */
  readonly column: string;
  readonly language: SearchLanguage;
  readonly sources: readonly SearchSource[];
  /** The `generated always as (…) stored` body. Deterministic in declaration order. */
  readonly expression: string;
}

/**
 * One `setweight(to_tsvector(…))` per source, concatenated in DECLARATION order.
 *
 * `setweight` even for a single unweighted source, so adding a second column never rewrites the
 * first one's spelling — and a spelling change here is a `drop column` + `add column` on a table
 * that may hold every row an app has. `coalesce(…, '')` because `to_tsvector` of NULL is NULL and
 * `NULL || tsvector` is NULL: one nullable source would erase the whole vector for that row.
 *
 * Every function in it is immutable, which is what Postgres requires of a generated column —
 * `to_tsvector(text)` with no configuration is NOT (it reads `default_text_search_config`), which
 * is why the language is named here and never left to the server.
 */
export const searchExpression = (
  language: SearchLanguage,
  sources: readonly SearchSource[],
): string =>
  sources
    .map(
      (source) =>
        `setweight(to_tsvector('${language}', coalesce("${source.column}", '')), '${source.weight}')`,
    )
    .join(' || ');

/**
 * The vector a set of already-resolved sources describes, or `null` when there are none.
 *
 * The physical names arrive resolved and the collision check arrives as `taken`, so this module
 * imports nothing from `column.ts` — which imports THIS one for `.searchable()`. A cycle between
 * the column chain and the thing a column modifier declares is avoidable, so it is avoided.
 */
export const searchVectorOf = (
  sources: readonly SearchSource[],
  init: SearchInit | undefined,
  taken: (column: string) => boolean,
  refuse: (subject: string, detail: string) => never,
): SearchVector | null => {
  if (sources.length === 0) {
    if (init === undefined) return null;
    return refuse(
      'search',
      'search is declared but no column is searchable — add .searchable() to a text() column, or drop the search option',
    );
  }
  const language = init?.language ?? DEFAULT_SEARCH_LANGUAGE;
  if (!isSearchLanguage(language)) {
    return refuse(
      'search',
      `"${String(language)}" is not a Postgres text search configuration — one of: ${SEARCH_LANGUAGES.join(', ')}`,
    );
  }
  const column = init?.column ?? DEFAULT_SEARCH_COLUMN;
  if (taken(column)) {
    return refuse(
      'search',
      `the search vector column "${column}" is already a declared column — rename it, or name another with search: { column: '<name>' }`,
    );
  }
  return { column, language, sources, expression: searchExpression(language, sources) };
};
