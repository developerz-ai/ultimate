// Ranking is the whole product here: an agent asks one question and reads the top few answers.
// The failure cases are the ones that would waste that: matching everything, matching nothing a
// human would call relevant, and ordering that changes between runs.

import { describe, expect, test } from 'bun:test';
import type { DocEntry } from './docs-scan';
import { nearestTopics, searchDocs, tokenize } from './docs-search';

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

  test('a query below the coverage floor still gets the topics it half-matched', () => {
    expect(nearestTopics(corpus, 'kubernetes ingress annotation rewrite retry')).toEqual([
      'jobs.retry',
    ]);
  });

  test('a query related to nothing suggests nothing, rather than five random topics', () => {
    expect(nearestTopics(corpus, 'kubernetes ingress annotations')).toEqual([]);
  });

  test('limit caps the result set without changing what wins', () => {
    const all = searchDocs(corpus, 'retry job');
    expect(all.length).toBeGreaterThan(1);
    const capped = searchDocs(corpus, 'retry job', 1);
    expect(capped.length).toBe(1);
    expect(capped[0]?.entry.topic).toBe(all[0]?.entry.topic);
  });
});
