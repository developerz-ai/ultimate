// Ranking doc entries against a natural-language question. Pure — no I/O, no clock — so the
// order it produces is a function of its input alone, and a scan plus a search is reproducible.

import type { DocEntry } from './docs-scan';
import { SYNONYMS } from './docs-synonyms';
import { stem, tokenize } from './docs-tokens';

/**
 * The tie-break, in CODE UNITS. Never `localeCompare`: with no locale argument it answers from the
 * runtime's ICU default and collation version, so one corpus ranks two ways on two machines and
 * this file's header — "the order it produces is a function of its input alone" — stops being
 * true. `@ultimat3/jobs`' `job.ts` states the same rule for the manifest it emits; the comparator
 * is restated rather than imported because that package is not below this one on the tier table.
 */
const byTopic = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
/**
 * A task word the synonyms table maps to a mechanism. Where the entry EXPORTS that name, it is the
 * strongest signal the ranker has — stronger than typing the name, because a curated row says
 * this is the page the task is answered on, and prose that discusses the task must not outrank
 * it. An entry that only mentions the name (a header, a longer symbol) earns a partial symbol's.
 */
const SYNONYM_EXPORT = 2 * EXACT_SYMBOL;
const SYNONYM_MENTION = PARTIAL_SYMBOL;
const TOPIC = 7;
const PACKAGE = 3;
const TITLE = 3;
const TEXT = 1;
const MAX_TEXT_SCORE = 6;
/** Applied once, to a guide entry, when the question asks for rationale rather than an API. */
const RATIONALE_BONUS = 5;

/** Every lowercased view of one entry a token is compared against, computed once per entry. */
interface Prepared {
  readonly symbolsLower: readonly string[];
  readonly topicStems: readonly string[];
  readonly packageStem: string;
  readonly titleLower: string;
  readonly textLower: string;
}

/**
 * Keyed on the entry object, so the memo can never answer for a different entry and an entry
 * nobody holds is collected. Twenty questions over the shipped tree recomputed these 56,000 times;
 * the result is a function of the entry alone, so this file stays pure.
 */
const PREPARED = new WeakMap<DocEntry, Prepared>();

function prepare(entry: DocEntry): Prepared {
  const known = PREPARED.get(entry);
  if (known !== undefined) return known;
  const prepared: Prepared = {
    symbolsLower: entry.symbols.map((symbol) => symbol.toLowerCase()),
    topicStems: tokenize(entry.topic).map(stem),
    packageStem: stem(entry.package.split('/').at(-1)?.toLowerCase() ?? ''),
    titleLower: entry.title.toLowerCase(),
    textLower: entry.text.toLowerCase(),
  };
  PREPARED.set(entry, prepared);
  return prepared;
}

interface SynonymHit {
  readonly target: string;
  readonly score: number;
}

/** The mechanism `word` stands for, when this entry exports it or its symbols or header name it. */
function synonymOf(
  word: string,
  symbolsLower: readonly string[],
  titleLower: string,
): SynonymHit | undefined {
  const targets = SYNONYMS.get(word);
  if (targets === undefined) return undefined;
  const exported = targets.find((target) => symbolsLower.includes(target));
  if (exported !== undefined) return { target: exported, score: SYNONYM_EXPORT };
  const mentioned = targets.find(
    (target) =>
      titleLower.includes(target) || symbolsLower.some((symbol) => symbol.includes(target)),
  );
  return mentioned === undefined ? undefined : { target: mentioned, score: SYNONYM_MENTION };
}

function scoreEntry(
  entry: DocEntry,
  tokens: readonly string[],
  rationale: boolean,
): DocHit | undefined {
  const { symbolsLower, topicStems, packageStem, titleLower, textLower } = prepare(entry);
  const matched: string[] = [];
  let score = 0;
  let textScore = 0;

  let covered = 0;
  let answered = false;
  for (const word of tokens) {
    const before = score + textScore;
    // The stem, not the word, against every name and every line of prose: `upgrade` has to reach
    // `Upgrading`, and `jobs` the `job` module. A symbol stays exact-or-substring on the word.
    const root = stem(word);
    // Symbol, topic and package name are three views of ONE fact — "this thing is called that".
    // Summing them let a word that is a package name, its module name and its exported type
    // (`money`) out-score three genuinely independent hits, so the strongest view wins alone.
    const exact = symbolsLower.indexOf(word);
    const partial = exact >= 0 ? -1 : symbolsLower.findIndex((symbol) => symbol.includes(word));
    const symbolScore = exact >= 0 ? EXACT_SYMBOL : partial >= 0 ? PARTIAL_SYMBOL : 0;
    const synonym = synonymOf(word, symbolsLower, titleLower);
    const nameScore = Math.max(
      symbolScore,
      synonym?.score ?? 0,
      topicStems.includes(root) ? TOPIC : 0,
      packageStem === root ? PACKAGE : 0,
    );
    score += nameScore;
    const named = entry.symbols[exact >= 0 ? exact : partial];
    if (synonym?.score === SYNONYM_EXPORT) answered = true;
    if (exact >= 0 && named !== undefined) matched.push(named);
    else if (synonym !== undefined) {
      if (!matched.includes(synonym.target)) matched.push(synonym.target);
    } else if (symbolScore > 0 && named !== undefined) matched.push(named);
    else if (nameScore > 0 && !matched.includes(word)) matched.push(word);

    // Prose is independent evidence of the same word, and is counted on top — capped, so a long
    // document cannot out-argue the declaration it describes.
    if (titleLower.includes(root)) {
      score += TITLE;
      if (!matched.includes(word)) matched.push(word);
    } else if (textLower.includes(root)) {
      textScore += TEXT;
      if (!matched.includes(word)) matched.push(word);
    }
    // Counted per query word, not per hit: a word that matched a symbol AND the prose is still
    // one of the question's words accounted for.
    if (score + textScore > before) covered += 1;
  }
  score += Math.min(textScore, MAX_TEXT_SCORE);
  if (score === 0) return undefined;
  return {
    entry,
    score: score + (rationale && entry.kind === 'guide' ? RATIONALE_BONUS : 0),
    matched,
    // The coverage floor exists to refuse an entry that merely MENTIONS one word of a long
    // question. The export a synonym names is not a mention: the table asserts the question names this mechanism's
    // task ("wait until the user stops typing" is `debounce`), so the whole question is answered.
    covered: answered ? tokens.length : covered,
  };
}

/**
 * At an equal score, prose a human wrote about the task beats the header of a file that mentions
 * it: the guide says how to do the thing, the module only that it exists.
 */
const byKind = (a: DocHit, b: DocHit): number =>
  a.entry.kind === b.entry.kind ? 0 : a.entry.kind === 'guide' ? -1 : 1;

/**
 * Ranked answers to a question, best first. A query that earns no points anywhere returns an
 * empty list rather than the corpus: a search that always answers teaches an agent to trust an
 * answer that was never about its question.
 *
 * Ties break on kind (guide first), then on topic, never on scan order, so the corpus can be assembled in any order and the
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
  hits.sort((a, b) => b.score - a.score || byKind(a, b) || byTopic(a.entry.topic, b.entry.topic));
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
    for (const word of tokens) {
      if (topic.includes(word)) score += 2;
      // A prefix, so `retries` still reaches `retry` and `caching` reaches `cache`. Four
      // characters, because three matches almost everything.
      else if (word.length >= 4 && topic.includes(word.slice(0, 4))) score += 1;
    }
    if (score > 0) scored.push({ topic: entry.topic, score });
  }
  scored.sort((a, b) => b.score - a.score || byTopic(a.topic, b.topic));
  return [...new Set(scored.map((item) => item.topic))].slice(0, limit);
}
