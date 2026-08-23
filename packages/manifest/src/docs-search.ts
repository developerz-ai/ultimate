// Ranking doc entries against a natural-language question. Pure — no I/O, no clock — so the
// order it produces is a function of its input alone, and a scan plus a search is reproducible.

import type { DocEntry } from './docs-scan';

/**
 * The tie-break, in CODE UNITS. Never `localeCompare`: with no locale argument it answers from the
 * runtime's ICU default and collation version, so one corpus ranks two ways on two machines and
 * this file's header — "the order it produces is a function of its input alone" — stops being
 * true. `@ultimat3/jobs`' `job.ts` states the same rule for the manifest it emits; the comparator
 * is restated rather than imported because that package is not below this one on the tier table.
 */
const byTopic = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Words that carry no signal in a question about an API. Deliberately tiny: every word removed
 * here is a word an agent cannot search for, and `get`, `set`, `run` and `new` are all real
 * symbol names in this framework.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
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
  const push = (token: string): void => {
    if (token.length < 2 || STOPWORDS.has(token) || out.includes(token)) return;
    out.push(token);
  };
  // Case is load-bearing until after the split: lowercasing first erases the boundary in
  // `nextRetry`, which is the one this exists to find.
  for (const word of query.split(/[^a-zA-Z0-9]+/)) {
    if (word === '') continue;
    const parts = word.split(/(?<=[a-z0-9])(?=[A-Z])/);
    for (const part of parts) push(part.toLowerCase());
    if (parts.length > 1) push(word.toLowerCase());
  }
  return out;
}

/**
 * A question about rationale wants the prose a human wrote, not the declaration site: "why is
 * money never a float" is answered by the README section that argues it, while the module that
 * exports `Money` merely contains the word. `how` is deliberately absent — "how do I call job()"
 * is a question about an API, and the symbol is the better answer.
 */
const RATIONALE = /^\s*(why|should|when should)\b/i;

export interface DocHit {
  readonly entry: DocEntry;
  readonly score: number;
  /** The symbols and words that earned the hit — why this answer, not just which. */
  readonly matched: readonly string[];
  /** How many of the query's tokens this entry accounted for. See `COVERAGE`. */
  readonly covered: number;
}

/**
 * The share of a question's words an entry must account for to be offered as an answer.
 *
 * Without this, "kubernetes ingress annotation rewrite-target" returned `cli.cmd-build` — one
 * token of five, matched on `--target` — presented in the same shape as a real answer. An agent
 * cannot see that difference, and a confident irrelevant answer is worse than no answer, because
 * it stops the search. Half the words is the line between "about this" and "mentions this".
 */
const COVERAGE = 0.5;

/**
 * Weights, highest first: an exact public symbol name is the strongest possible signal that this
 * is the file the question is about; prose is the weakest, because every package's README says
 * "cache" somewhere. Prose is capped so a long document cannot out-score the declaration itself.
 */
const EXACT_SYMBOL = 12;
const PARTIAL_SYMBOL = 4;
const TOPIC = 7;
const PACKAGE = 3;
const TITLE = 3;
const TEXT = 1;
const MAX_TEXT_SCORE = 6;
/** Applied once, to a guide entry, when the question asks for rationale rather than an API. */
const RATIONALE_BONUS = 5;

function scoreEntry(
  entry: DocEntry,
  tokens: readonly string[],
  rationale: boolean,
): DocHit | undefined {
  const symbolsLower = entry.symbols.map((symbol) => symbol.toLowerCase());
  const topicTokens = tokenize(entry.topic);
  const packageToken = entry.package.split('/').at(-1)?.toLowerCase() ?? '';
  const titleLower = entry.title.toLowerCase();
  const textLower = entry.text.toLowerCase();
  const matched: string[] = [];
  let score = 0;
  let textScore = 0;

  let covered = 0;
  for (const token of tokens) {
    const before = score + textScore;
    // Symbol, topic and package name are three views of ONE fact — "this thing is called that".
    // Summing them let a token that is a package name, its module name and its exported type
    // (`money`) out-score three genuinely independent hits, so the strongest view wins alone.
    const exact = symbolsLower.indexOf(token);
    const partial = exact >= 0 ? -1 : symbolsLower.findIndex((symbol) => symbol.includes(token));
    const symbolScore = exact >= 0 ? EXACT_SYMBOL : partial >= 0 ? PARTIAL_SYMBOL : 0;
    const nameScore = Math.max(
      symbolScore,
      topicTokens.includes(token) ? TOPIC : 0,
      packageToken === token ? PACKAGE : 0,
    );
    score += nameScore;
    const named = entry.symbols[exact >= 0 ? exact : partial];
    if (symbolScore > 0 && named !== undefined) matched.push(named);
    else if (nameScore > 0 && !matched.includes(token)) matched.push(token);

    // Prose is independent evidence of the same token, and is counted on top — capped, so a long
    // document cannot out-argue the declaration it describes.
    if (titleLower.includes(token)) {
      score += TITLE;
      if (!matched.includes(token)) matched.push(token);
    } else if (textLower.includes(token)) {
      textScore += TEXT;
      if (!matched.includes(token)) matched.push(token);
    }
    // Counted per query token, not per hit: a token that matched a symbol AND the prose is still
    // one of the question's words accounted for.
    if (score + textScore > before) covered += 1;
  }
  score += Math.min(textScore, MAX_TEXT_SCORE);
  if (score === 0) return undefined;
  return {
    entry,
    score: score + (rationale && entry.kind === 'guide' ? RATIONALE_BONUS : 0),
    matched,
    covered,
  };
}

/**
 * Ranked answers to a question, best first. A query that earns no points anywhere returns an
 * empty list rather than the corpus: a search that always answers teaches an agent to trust an
 * answer that was never about its question.
 *
 * Ties break on topic, never on scan order, so the corpus can be assembled in any order and the
 * ranking still reproduces.
 */
export function searchDocs(
  entries: readonly DocEntry[],
  query: string,
  limit = 8,
): readonly DocHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const rationale = RATIONALE.test(query);
  const required = Math.ceil(tokens.length * COVERAGE);
  const hits: DocHit[] = [];
  for (const entry of entries) {
    const hit = scoreEntry(entry, tokens, rationale);
    if (hit !== undefined && hit.covered >= required) hits.push(hit);
  }
  hits.sort((a, b) => b.score - a.score || byTopic(a.entry.topic, b.entry.topic));
  return hits.slice(0, limit);
}

/**
 * Nearest topics for a question that matched nothing — the same "here is what does exist" move
 * `x errors explain` makes for an unregistered code, so a miss still ends in something runnable.
 */
export function nearestTopics(
  entries: readonly DocEntry[],
  query: string,
  limit = 5,
): readonly string[] {
  const tokens = tokenize(query);
  const scored: { topic: string; score: number }[] = [];
  for (const entry of entries) {
    const topic = entry.topic.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (topic.includes(token)) score += 2;
      // A prefix, so `retries` still reaches `retry` and `caching` reaches `cache`. Four
      // characters, because three matches almost everything.
      else if (token.length >= 4 && topic.includes(token.slice(0, 4))) score += 1;
    }
    if (score > 0) scored.push({ topic: entry.topic, score });
  }
  scored.sort((a, b) => b.score - a.score || byTopic(a.topic, b.topic));
  return [...new Set(scored.map((item) => item.topic))].slice(0, limit);
}
