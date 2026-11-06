// Which of a long, closed list of options a query names, and in what order — a leaf over
// `normalizeQuery`, so `SearchableSelect` and anything else ranking labels (`CommandPalette`) fold
// case and accents by the one rule `Combobox` already uses, and retain no listbox to get it.

import { finiteCount } from '@ultimat3/core';
import { COMBOBOX_LIMIT, normalizeQuery } from './combobox-filter';

/** The text a ranker reads: the visible label, its second line, and words the label never shows. */
export interface RankableOption {
  readonly label: string;
  readonly description?: string | undefined;
  /** Synonyms a reader may type — "GMT" for `Europe/London`. Never rendered. */
  readonly keywords?: readonly string[] | undefined;
}

export interface RankedOptions<T> {
  /** The first `limit` matches, best first; a rank keeps the caller's order. */
  readonly matches: readonly T[];
  /** Every match before the cap — "first 25 of 140" is spoken from this. */
  readonly total: number;
}

const WORD_BREAK = /[\s/_\-.,()]+/u;

/**
 * 0: the label starts with the query. 1: any word of label, description or keywords does.
 * 2: the query sits inside one of them. -1: no match. A label prefix outranks a word prefix
 * because it is the row a reader typing the start of a name is looking at.
 */
export function optionRank(option: RankableOption, needle: string): number {
  const label = normalizeQuery(option.label);
  if (needle === '' || label.startsWith(needle)) return 0;
  const texts = [label, ...[option.description, ...(option.keywords ?? [])].map(normal)];
  if (texts.some((text) => text.split(WORD_BREAK).some((word) => word.startsWith(needle)))) {
    return 1;
  }
  return texts.some((text) => text.includes(needle)) ? 2 : -1;
}

const normal = (text: string | undefined): string =>
  text === undefined ? '' : normalizeQuery(text);

/**
 * `options` narrowed to `query` and ordered by `optionRank`, stable within a rank. An empty query
 * is every option in the caller's order. `limit` counts rows, so it is held to a whole number.
 */
export function rankOptions<T extends RankableOption>(
  options: readonly T[],
  query: string,
  limit: number = COMBOBOX_LIMIT,
): RankedOptions<T> {
  const cap = finiteCount('rankOptions', 'limit', limit, 0);
  const needle = normalizeQuery(query);
  const buckets: T[][] = [[], [], []];
  for (const option of options) {
    const rank = optionRank(option, needle);
    if (rank >= 0) buckets[rank]?.push(option);
  }
  const all = buckets.flat();
  return { matches: all.slice(0, cap), total: all.length };
}
