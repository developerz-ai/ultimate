// What a query matches, as a pure rule. Runs on the server for the first paint and again on
// every debounced keystroke, so a no-JS form round-trip and a live filter narrow the list the
// same way — two matchers would eventually disagree, and the user would see the list flicker.

import { finiteCount } from '@ultimat3/core';

export interface ComboboxOption {
  /** The text the field takes when the suggestion is picked — and what the form submits. */
  value: string;
  /** Already-translated hint shown beside the value. */
  hint?: string | undefined;
}

/** Suggestions rendered when the caller sets no limit. Long lists are a scroll, not an answer. */
export const COMBOBOX_LIMIT = 25;

/**
 * Case- and accent-insensitive: someone typing `cafe` means `Café`, and a filter that disagrees
 * reads as "the option is missing".
 */
export function normalizeQuery(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

const haystack = (option: ComboboxOption): string =>
  normalizeQuery(option.hint === undefined ? option.value : `${option.value} ${option.hint}`);

/**
 * Matches ranked prefix-first, then substring, each keeping the caller's order. Prefix first
 * because the first suggestion is the one the browser completes to.
 */
export function filterOptions(
  options: readonly ComboboxOption[],
  query = '',
  limit: number = COMBOBOX_LIMIT,
): readonly ComboboxOption[] {
  // A BARE PARAMETER DEFAULT, which `??` never guards and `scripts/finite-bounds.ts` cannot see:
  // `slice(0, NaN)` is `[]`, so every suggestion vanishes and `<Combobox>` renders "no results" for
  // a list that matched. `Infinity` is the mirror — every option rendered, out of the function
  // whose own doc says long lists are a scroll, not an answer. 0 stays legal: it renders nothing,
  // on purpose and visibly.
  const cap = finiteCount('filterOptions', 'limit', limit, 0);
  const needle = normalizeQuery(query);
  if (needle === '') return options.slice(0, cap);

  const prefix: ComboboxOption[] = [];
  const contains: ComboboxOption[] = [];
  for (const option of options) {
    const text = haystack(option);
    if (text.startsWith(needle)) prefix.push(option);
    else if (text.includes(needle)) contains.push(option);
  }
  return [...prefix, ...contains].slice(0, cap);
}
