import { expect, unitTest } from '@ultimat3/testing';
import { FOOTER_ANCHOR, SEARCH_INDEX_PATH, wikiSourceUrl } from './docs-links';

unitTest('a page names its wiki source on GitHub; the fixed paths are absolute', () => {
  expect(wikiSourceUrl('Money.md')).toBe(
    'https://github.com/developerz-ai/ultimate/blob/main/wiki/Money.md',
  );
  expect(FOOTER_ANCHOR.startsWith('#')).toBe(true);
  expect(SEARCH_INDEX_PATH.startsWith('/')).toBe(true);
});
