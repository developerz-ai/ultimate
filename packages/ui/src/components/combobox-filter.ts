// What a query matches, as a pure rule. Runs on the server for the first paint and again on
// every debounced keystroke, so a no-JS form round-trip and a live filter narrow the list the
// same way — two matchers would eventually disagree, and the user would see the list flicker.

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
  const needle = normalizeQuery(query);
  if (needle === '') return options.slice(0, limit);

  const prefix: ComboboxOption[] = [];
  const contains: ComboboxOption[] = [];
  for (const option of options) {
    const text = haystack(option);
    if (text.startsWith(needle)) prefix.push(option);
    else if (text.includes(needle)) contains.push(option);
  }
  return [...prefix, ...contains].slice(0, limit);
}
