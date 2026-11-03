// Ranking is the whole product here: an agent asks one question and reads the top few answers.
// The failure cases are the ones that would waste that: matching everything, matching nothing a
// human would call relevant, and ordering that changes between runs.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path module; the eval reads this repository's own tree off disk.
import { join } from 'node:path';
import type { DocEntry } from './docs-scan';
import { scanInstalledDocs } from './docs-scan';
import { nearestTopics, searchDocs } from './docs-search';
import { DOCS_EVAL_SET, EVAL_FLOOR, EVAL_TOP, isWanted } from './docs-search-eval-set-fixture';
import { stem, tokenize } from './docs-tokens';
import { scanWikiDocs } from './docs-wiki';

const entry = (over: Partial<DocEntry> & Pick<DocEntry, 'topic'>): DocEntry => ({
  package: '@ultimat3/jobs',
  version: '1.2.0',
  kind: 'module',
  title: '',
  text: '',
  symbols: [],
  source: `src/${over.topic.split('.').at(-1)}.ts`,
  ...over,
});

const corpus: readonly DocEntry[] = [
  entry({
    topic: 'jobs.retry',
    title: 'Retry policy: backoff, jitter, and the attempt ceiling.',
    text: 'Retry policy: backoff, jitter, and the attempt ceiling.',
    symbols: ['DEFAULT_RETRY', 'RetryPolicy', 'backoffDelayMs', 'nextRetry', 'retrySchedule'],
  }),
  entry({
    topic: 'jobs.job',
    title: 'Durable background work with an idempotency key.',
    text: 'Durable background work with an idempotency key.',
    symbols: ['job', 'JobDefinition', 'JobHandle'],
  }),
  entry({
    topic: 'money.money',
    package: '@ultimat3/money',
    title: 'Minor units only.',
    text: 'Never a float. Money is minor units plus a currency.',
    symbols: ['Money', 'add'],
  }),
  entry({
    topic: 'money.README#why-no-floats',
    package: '@ultimat3/money',
    kind: 'guide',
    title: 'Why no floats',
    text: 'Binary floating point cannot represent 0.10, so money is an integer of minor units.',
    source: 'README.md',
  }),
];

describe('unit · tokenize', () => {
  test('a question of nothing but stopwords produces no tokens', () => {
    expect(tokenize('how does the what is a of')).toEqual([]);
  });

  test('call syntax and punctuation are not part of the word', () => {
    expect(tokenize('how does job() retry')).toEqual(['job', 'retry']);
  });

  test('camelCase and dotted topics split into their parts', () => {
    expect(tokenize('nextRetry')).toEqual(['next', 'retry', 'nextretry']);
    expect(tokenize('jobs.retry')).toEqual(['jobs', 'retry']);
  });
  test('a digit run is its own word, so a version number reaches the topic that carries it', () => {
    expect(tokenize('28x--2900-entry')).toEqual(['28', '28x', '2900', 'entry']);
    expect(tokenize('s3')).toEqual(['s3']);
  });

  test('stem takes one suffix off and never cuts a word below three characters', () => {
    expect(stem('upgrading')).toBe(stem('upgrade'));
    expect(stem('jobs')).toBe('job');
    expect(stem('uses')).toBe('uses');
    expect(stem('test')).toBe('test');
  });
});

describe('unit · searchDocs', () => {
  test('a query matching nothing returns nothing, never the whole corpus', () => {
    expect(searchDocs(corpus, 'kubernetes ingress annotations')).toEqual([]);
  });

  test('a query of only stopwords returns nothing', () => {
    expect(searchDocs(corpus, 'how does the')).toEqual([]);
  });

  // The regression this floor exists for: one incidental word out of five used to answer.
  test('an entry that merely mentions one word of a long question is not an answer', () => {
    expect(searchDocs(corpus, 'kubernetes ingress annotation rewrite retry')).toEqual([]);
  });

  test('the floor scales with the question — a short query still answers on one word', () => {
    expect(searchDocs(corpus, 'retry').length).toBeGreaterThan(0);
  });

  // The acceptance test from the brief, at the ranking layer.
  test('"how does job() retry" ranks the jobs package first', () => {
    const hits = searchDocs(corpus, 'how does job() retry');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entry.package).toBe('@ultimat3/jobs');
    expect(
      hits
        .slice(0, 2)
        .map((hit) => hit.entry.topic)
        .sort(),
    ).toEqual(['jobs.job', 'jobs.retry']);
    expect(hits[0]?.matched.length).toBeGreaterThan(0);
  });

  test('an exact symbol name outranks a prose mention of the same word', () => {
    const hits = searchDocs(corpus, 'nextRetry');
    expect(hits[0]?.entry.topic).toBe('jobs.retry');
    expect(hits[0]?.matched).toContain('nextRetry');
  });

  test('a conceptual question reaches human prose no symbol name carries', () => {
    const hits = searchDocs(corpus, 'why is money never a float');
    expect(hits[0]?.entry.source).toBe('README.md');
  });

  test('a package name alone scopes the answer to that package', () => {
    const hits = searchDocs(corpus, 'money');
    expect(hits.every((hit) => hit.entry.package === '@ultimat3/money')).toBe(true);
  });

  test('ordering does not depend on the order the corpus was scanned in', () => {
    const once = searchDocs(corpus, 'retry job');
    const twice = searchDocs([...corpus].reverse(), 'retry job');
    expect(once.length).toBeGreaterThan(1);
    expect(once.map((hit) => hit.entry.topic)).toEqual(twice.map((hit) => hit.entry.topic));
  });

  test('an exact score tie breaks on topic, not on scan order', () => {
    const tied: readonly DocEntry[] = [
      entry({ topic: 'b.cache', symbols: ['cache'] }),
      entry({ topic: 'a.cache', symbols: ['cache'] }),
    ];
    expect(searchDocs(tied, 'cache').map((hit) => hit.entry.topic)).toEqual(['a.cache', 'b.cache']);
    expect(searchDocs([...tied].reverse(), 'cache').map((hit) => hit.entry.topic)).toEqual([
      'a.cache',
      'b.cache',
    ]);
  });

  /**
   * ...and on CODE UNITS, never `localeCompare`, which answers from the runtime's ICU default and
   * collation version: `'a.Cache'.localeCompare('a.cache')` is `1` while `'a.Cache' < 'a.cache'`
   * is `true`, so one corpus ranked two ways on two machines — and this file's header states the
   * order is a function of its input alone. Same rule `@ultimat3/jobs`' `job.ts` states.
   */
  test('and on code units, so the same corpus ranks alike under any ICU', () => {
    const cased: readonly DocEntry[] = [
      entry({ topic: 'a.cache', symbols: ['cache'] }),
      entry({ topic: 'a.Cache', symbols: ['cache'] }),
    ];
    expect(searchDocs(cased, 'cache').map((hit) => hit.entry.topic)).toEqual([
      'a.Cache',
      'a.cache',
    ]);
  });

  test('a query below the coverage floor still gets the topics it half-matched', () => {
    expect(nearestTopics(corpus, 'kubernetes ingress annotation rewrite retry')).toEqual([
      'jobs.retry',
    ]);
  });

  test('a query related to nothing suggests nothing, rather than five random topics', () => {
    expect(nearestTopics(corpus, 'kubernetes ingress annotations')).toEqual([]);
  });

  // `upgrade` against the heading `Upgrading`, `jobs` against the `job` module: the measured
  // misses an exact-token compare could not answer.
  test('a word reaches a name and a heading that carry its stem', () => {
    const upgrading = entry({
      topic: 'wiki.Upgrading#28x--2900-entry-by-entry',
      package: '@ultimat3/cli',
      kind: 'guide',
      title: '28.x → 29.0.0, entry by entry',
    });
    expect(searchDocs([upgrading], 'upgrade 28')[0]?.entry.topic).toBe(upgrading.topic);
  });

  test('at an equal score the guide outranks the source header', () => {
    const tied: readonly DocEntry[] = [
      entry({ topic: 'a.drain', title: 'drain' }),
      entry({ topic: 'z.README#drain', kind: 'guide', title: 'drain' }),
    ];
    expect(searchDocs(tied, 'drain').map((hit) => hit.entry.topic)).toEqual([
      'z.README#drain',
      'a.drain',
    ]);
  });

  test('limit caps the result set without changing what wins', () => {
    const all = searchDocs(corpus, 'retry job');
    expect(all.length).toBeGreaterThan(1);
    const capped = searchDocs(corpus, 'retry job', 1);
    expect(capped.length).toBe(1);
    expect(capped[0]?.entry.topic).toBe(all[0]?.entry.topic);
  });
});

// `nearestTopics` is the consolation path — what an agent reads when its question matched
// nothing. Its ranking had never been exercised with more than one candidate, so the comparator
// that decides which suggestion comes first ran zero times.
describe('unit · nearestTopics ranking', () => {
  test('a topic matching more of the question outranks one matching less', () => {
    // `jobs.retry` contains both words, `jobs.job` only one.
    expect(nearestTopics(corpus, 'retry job')).toEqual(['jobs.retry', 'jobs.job']);
  });

  test('an equal score breaks on the topic name, not on scan order', () => {
    const tied: readonly DocEntry[] = [
      entry({ topic: 'b.retry' }),
      entry({ topic: 'a.retry' }),
      entry({ topic: 'c.retry' }),
    ];
    expect(nearestTopics(tied, 'retry')).toEqual(['a.retry', 'b.retry', 'c.retry']);
    expect(nearestTopics([...tied].reverse(), 'retry')).toEqual(['a.retry', 'b.retry', 'c.retry']);
  });

  test('a prefix match is worth strictly less than the whole word', () => {
    // `retries` is not a substring of `a.retry`, but its first four characters are — worth 1,
    // where `z.retries` carries the whole token and is worth 2. The topics are lettered so that
    // a prefix scoring the SAME as a whole word would flip the order via the alphabetical
    // tie-break rather than leaving it alone.
    const entries: readonly DocEntry[] = [
      entry({ topic: 'a.retry' }),
      entry({ topic: 'z.retries' }),
    ];
    expect(nearestTopics(entries, 'retries')).toEqual(['z.retries', 'a.retry']);
    // And a prefix match is still a match — the half-relevant topic is offered, not dropped.
    expect(nearestTopics([entry({ topic: 'jobs.retry' })], 'retries')).toEqual(['jobs.retry']);
    // A word sharing nothing with the topic earns nothing.
    expect(nearestTopics([entry({ topic: 'jobs.retry' })], 'kubernetes')).toEqual([]);
  });

  /**
   * The tie-break is CODE UNITS, never `localeCompare`. This file's header states the order is a
   * function of the input alone, and `localeCompare` with no locale argument answers from the
   * runtime's ICU default and collation version: `'a.Retry'.localeCompare('a.retry')` is `1` and
   * `'a.Retry' < 'a.retry'` is `true`, so one corpus ranked two ways on two machines — and
   * `x docs search` is what an agent quotes back. Same rule `@ultimat3/jobs`' `job.ts` states.
   */
  test('a tie breaks on code units, so two ICU builds rank one corpus alike', () => {
    const cased: readonly DocEntry[] = [entry({ topic: 'a.retry' }), entry({ topic: 'a.Retry' })];
    expect(nearestTopics(cased, 'retry')).toEqual(['a.Retry', 'a.retry']);
  });

  test('one topic is suggested once, however many entries carry it', () => {
    const duplicated: readonly DocEntry[] = [
      entry({ topic: 'jobs.retry', source: 'src/a.ts' }),
      entry({ topic: 'jobs.retry', source: 'src/b.ts' }),
    ];
    expect(nearestTopics(duplicated, 'retry')).toEqual(['jobs.retry']);
  });

  test('limit caps the suggestions from the top, not from the middle', () => {
    const many: readonly DocEntry[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((letter) =>
      entry({ topic: `${letter}.retry` }),
    );
    expect(nearestTopics(many, 'retry')).toHaveLength(5);
    expect(nearestTopics(many, 'retry', 2)).toEqual(['a.retry', 'b.retry']);
  });
});

// The regression set, scored over the real tree this repository ships: every package's README,
// CLAUDE.md and source headers, plus the wiki the CLI tarball carries. The floor is the promise
// `x docs` makes to an agent with a task and no filename; a ranking change that drops a question
// out of the top three shows up here as the one question it lost.
describe('eval · the task questions an adopter asked', () => {
  test(`at least ${EVAL_FLOOR} of ${DOCS_EVAL_SET.length} land the right package in the top ${EVAL_TOP}`, async () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const entries = [
      ...(await scanInstalledDocs(join(root, 'packages'))),
      ...(await scanWikiDocs(join(root, 'wiki'), { package: '@ultimat3/cli', version: '0.0.0' })),
    ];
    const missed = DOCS_EVAL_SET.filter(
      ({ question, wanted }) =>
        !searchDocs(entries, question, EVAL_TOP).some((hit) => isWanted(hit.entry.topic, wanted)),
    ).map(({ question }) => question);
    // The missed questions ARE the failure message: a bare count says the ranker regressed and
    // not on what.
    const allowed = DOCS_EVAL_SET.length - EVAL_FLOOR;
    expect(missed.length <= allowed ? [] : missed).toEqual([]);
  });

  test('isWanted takes a topic under a prefix, never one that merely shares its letters', () => {
    expect(isWanted('mail.mail', ['mail'])).toBe(true);
    expect(isWanted('wiki.Upgrading#28x--2900-entry-by-entry', ['wiki.Upgrading'])).toBe(true);
    expect(isWanted('wiki.Upgrading', ['wiki.Upgrading'])).toBe(true);
    expect(isWanted('mailer.send', ['mail'])).toBe(false);
  });
});
