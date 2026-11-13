// Ten questions phrased as the TASK, never the API's name, each pinned to the page that answers
// it — every one must land, there is no floor. And the synonyms table may only name a symbol the
// shipped tree exports, so a rename that orphans a row fails here rather than ranking nothing.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path module; the set is scored over this repository's own tree off disk.
import { join } from 'node:path';
import type { DocEntry } from './docs-scan';
import { scanInstalledDocs } from './docs-scan';
import { searchDocs } from './docs-search';
import { EVAL_TOP, isWanted } from './docs-search-eval-set-fixture';
import { SYNONYMS } from './docs-synonyms';
import { scanWikiDocs } from './docs-wiki';

/** Question → the topics a right answer starts with (`isWanted`'s prefix rule). */
const TASKS: readonly { readonly question: string; readonly wanted: readonly string[] }[] = [
  { question: 'paginate a query with a cursor', wanted: ['db.keyset'] },
  { question: 'poll every N seconds', wanted: ['realtime.query-poll', 'core.visible-interval'] },
  { question: 're-read a query on a timer', wanted: ['realtime.query-poll'] },
  { question: 'stop a timer while the tab is hidden', wanted: ['core.visible-interval'] },
  { question: 'map over a list with limited concurrency', wanted: ['core.map-bounded'] },
  { question: 'retry a promise without caching the rejection', wanted: ['core.retry-memo'] },
  {
    question: 'newest row per group',
    wanted: [
      'entity.latest-by',
      'wiki.Entities-And-Migrations#the-newest-row-per-group-is-latestby',
    ],
  },
  { question: 'wait until the user stops typing', wanted: ['ui.debounce'] },
  { question: 'take an advisory lock', wanted: ['entity.lock-key'] },
  { question: 'keep a denormalized count on the parent', wanted: ['entity.counter'] },
];

/**
 * Questions that share a table word with a row but are about something else. Each table word was
 * kept only once these stayed off its target: `existing`, `parallel` and `batches` were tried and
 * dropped, because "migrate an existing app", "parallel tests" and "send emails in batches" each
 * ranked a mechanism first that has nothing to do with them.
 */
const UNRELATED: readonly { readonly question: string; readonly not: string }[] = [
  { question: 'type a column', not: 'ui.debounce' },
  { question: 'parallel tests', not: 'core.map-bounded' },
  { question: 'migrate an existing app', not: 'jobs.backfill' },
  { question: 'send emails in batches', not: 'jobs.backfill' },
];

const root = join(import.meta.dir, '..', '..', '..');
const corpus = async (): Promise<readonly DocEntry[]> => [
  ...(await scanInstalledDocs(join(root, 'packages'))),
  ...(await scanWikiDocs(join(root, 'wiki'), { package: '@ultimat3/cli', version: '0.0.0' })),
];

describe('eval · task phrasing reaches the mechanism', () => {
  test(`each of ${TASKS.length} task questions lands its page in the top ${EVAL_TOP}`, async () => {
    const entries = await corpus();
    // The misses, with what came back instead, ARE the failure message.
    const missed = TASKS.flatMap(({ question, wanted }) => {
      const top = searchDocs(entries, question, EVAL_TOP).map((hit) => hit.entry.topic);
      return top.some((topic) => isWanted(topic, wanted))
        ? []
        : [`${question} → ${top.join(', ')}`];
    });
    expect(missed).toEqual([]);
  });

  test('the ranking is deterministic: a reversed corpus answers every task identically', async () => {
    const entries = await corpus();
    const reversed = [...entries].reverse();
    for (const { question } of TASKS) {
      const once = searchDocs(entries, question, EVAL_TOP).map((hit) => hit.entry.topic);
      const again = searchDocs(reversed, question, EVAL_TOP).map((hit) => hit.entry.topic);
      expect(again).toEqual(once);
    }
  });

  test('a question merely sharing a word with the table is not steered to its mechanism', async () => {
    const entries = await corpus();
    const steered = UNRELATED.filter(
      ({ question, not }) => searchDocs(entries, question, 1)[0]?.entry.topic === not,
    ).map(({ question, not }) => `${question} → ${not}`);
    expect(steered).toEqual([]);
  });
});

const entry = (over: Partial<DocEntry> & Pick<DocEntry, 'topic'>): DocEntry => ({
  package: '@ultimat3/core',
  version: '1.0.0',
  kind: 'module',
  title: '',
  text: '',
  symbols: [],
  source: 'src/x.ts',
  ...over,
});

describe('unit · searchDocs with synonyms', () => {
  const debounce = entry({ topic: 'ui.debounce', symbols: ['debounce'], title: 'Trailing edge.' });
  const prose = entry({
    topic: 'ui.README#forms',
    kind: 'guide',
    title: 'Forms: wait until the user stops typing',
    text: 'wait until the user stops typing before you validate',
  });
  const mention = entry({ topic: 'ui.input', title: 'An input; see debounce for keystrokes.' });

  test('the export a task word names outranks prose that repeats the whole question', () => {
    const hits = searchDocs([prose, debounce], 'wait until the user stops typing');
    expect(hits[0]?.entry.topic).toBe('ui.debounce');
    expect(hits[0]?.matched).toContain('debounce');
  });

  test('the export answers a long question alone; a mere mention still needs the floor', () => {
    const topics = searchDocs([debounce, mention], 'wait until the user stops typing').map(
      (hit) => hit.entry.topic,
    );
    expect(topics).toEqual(['ui.debounce']);
  });

  test('the table is keyed on the word, never its stem: `type` shares `typing`s stem', () => {
    expect(searchDocs([debounce], 'type')).toEqual([]);
  });
});

describe('unit · the synonyms table', () => {
  test('every target is a name the shipped tree exports or a header names', async () => {
    const entries = await corpus();
    const names = entries.flatMap((entry) => [
      ...entry.symbols.map((symbol) => symbol.toLowerCase()),
      entry.title.toLowerCase(),
    ]);
    const orphaned = [...SYNONYMS].flatMap(([word, targets]) =>
      targets
        .filter((target) => !names.some((name) => name.includes(target)))
        .map((target) => `${word} → ${target}`),
    );
    expect(orphaned).toEqual([]);
  });

  test('keys and targets are lowercase single words, so a lookup can never miss on case', () => {
    for (const [word, targets] of SYNONYMS) {
      expect(word).toMatch(/^[a-z0-9]+$/);
      for (const target of targets) expect(target).toMatch(/^[a-z0-9]+$/);
    }
  });
});
