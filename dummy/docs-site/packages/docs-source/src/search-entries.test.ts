import { expect, test } from 'bun:test';
import { searchDocs } from '@ultimat3/manifest/docs-search';
import { readCorpus } from './corpus';
import { FIXTURE_OPTIONS, WIKI } from './corpus-fixture';
import { searchEntries } from './search-entries';

const entries = searchEntries(readCorpus(WIKI, FIXTURE_OPTIONS));

test('a page, each of its sections and each code is one entry at its own URL', () => {
  const topics = entries.map((entry) => entry.topic);
  expect(topics).toContain('/getting-started');
  expect(topics).toContain('/getting-started#install');
  expect(topics).toContain('/upgrading/30#removed');
  expect(topics).toContain('/errors/X_DB_DRIFT');
  expect(entries.find((entry) => entry.topic === '/getting-started#install')?.text).toBe('Run it.');
});

test('the ranker the island runs finds a code by its name, first', () => {
  expect(searchDocs(entries, 'X_DB_DRIFT')[0]?.entry.topic).toBe('/errors/X_DB_DRIFT');
});

test('a long snippet is clipped', () => {
  const long = readCorpus(
    [{ file: 'Long.md', markdown: `# L\n\n${'word '.repeat(100)}` }],
    FIXTURE_OPTIONS,
  );
  const text = searchEntries(long)[0]?.text ?? '';
  expect(text.length).toBeLessThanOrEqual(241);
  expect(text.endsWith('…')).toBe(true);
});
