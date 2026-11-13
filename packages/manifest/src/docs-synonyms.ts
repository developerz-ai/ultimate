// Task words → the mechanism that does the task. An agent asks "paginate with a cursor", never
// "keyset"; this table is that bridge. Pure data, read by `docs-search.ts`, held by
// `docs-synonyms.test.ts` (ten task questions, and every target a name the shipped tree carries).

/**
 * Keyed on the query's own lowercased word, NOT its stem: `typing` stems to `typ`, which `type`
 * shares, and "type" is no question about debounce. Every inflection is therefore its own row.
 * A target is matched against an entry's symbols and its header line, case-folded, as a
 * substring — so `latestby` reaches `LatestByOptions` and `lockkeys` the header naming `lockKeys`.
 * Only words that name ONE task belong here: `page`, `batch` and `count` mean too many things.
 */
const ROWS: readonly (readonly [readonly string[], readonly string[]])[] = [
  [['paginate', 'paginated', 'paginating', 'pagination'], ['keyset']],
  [
    ['poll', 'polls', 'polling', 'timer', 'interval'],
    ['pollevery', 'visibleinterval'],
  ],
  [['concurrency', 'concurrently'], ['mapbounded']],
  [['memoize', 'memoise'], ['retrymemo']],
  [['newest', 'latest'], ['latestby']],
  [['typing', 'keystroke', 'keystrokes'], ['debounce']],
  [['advisory', 'mutex'], ['lockkeys']],
  [['denormalize', 'denormalise', 'denormalized', 'denormalised'], ['countedin']],
];

export const SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map(
  ROWS.flatMap(([words, targets]) => words.map((word) => [word, targets] as const)),
);
