// A question, and every name it is scored against, as the words `docs-search.ts` compares: split,
// lowercased, stop words dropped, and stemmed one suffix deep. Pure, and shared by both sides of
// the comparison so a query and a topic can never be cut two different ways.

/**
 * Words that carry no signal in a question about an API. Deliberately tiny: every word removed
 * here is a word an agent cannot search for, and `get`, `set`, `run` and `new` are all real
 * symbol names in this framework.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'the',
  'to',
  'use',
  'using',
  'was',
  'what',
  'when',
  'where',
  'which',
  'why',
  'with',
  'you',
  'your',
]);

/**
 * Split on non-alphanumerics, then split camelCase — so `nextRetry` answers a query for `retry`
 * and `retry` answers one for `nextRetry`. The joined original is kept alongside its parts so an
 * exact symbol name can still score as an exact hit.
 */
export function tokenize(query: string): readonly string[] {
  const out: string[] = [];
  const push = (piece: string): void => {
    if (piece.length < 2 || STOPWORDS.has(piece) || out.includes(piece)) return;
    out.push(piece);
  };
  // Case is load-bearing until after the split: lowercasing first erases the boundary in
  // `nextRetry`, which is the one this exists to find.
  for (const word of query.split(/[^a-zA-Z0-9]+/)) {
    if (word === '') continue;
    // A digit run is its own word too, so `28` reaches the topic `wiki.Upgrading#28x--2900-…`.
    const parts = word.split(
      /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/,
    );
    for (const part of parts) push(part.toLowerCase());
    if (parts.length > 1) push(word.toLowerCase());
  }
  return out;
}

/**
 * The crudest stem that closes the gap measured: `upgrade` never matched `Upgrading`, nor `job`
 * the `jobs` package. One suffix off, only while three characters remain, so `uses` and `test` keep
 * their meaning. Not a linguistic stemmer and not meant to be one — no dependency, no dictionary.
 */
export const stem = (word: string): string => {
  const cut = /(?:ing|ed|es|s|e)$/.exec(word);
  return cut !== null && word.length - cut[0].length >= 3 ? word.slice(0, cut.index) : word;
};
