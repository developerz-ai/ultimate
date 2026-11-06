// The corpus, read from this repository's real `wiki/`: the pages, codes and majors every route
// prerenders exist, and every code the framework registers has one (the loader throws otherwise).
import { expect, unitTest } from '@ultimat3/testing';
import { codePage, docPage, docsCorpus } from './docs';

unitTest('the real wiki reads into pages, code pages and majors, once per process', async () => {
  const corpus = await docsCorpus();
  expect(docsCorpus()).toBe(docsCorpus());
  expect(corpus.pages.map((piece) => piece.url)).toContain('/getting-started');
  expect(corpus.majors.length).toBeGreaterThan(20);
  expect(corpus.codes.length).toBeGreaterThan(1000);
});

unitTest('a page and a code are found by URL and name; anything else is undefined', async () => {
  expect((await docPage('/getting-started'))?.title).toBe('Getting started');
  expect((await docPage('/upgrading/30'))?.title).toContain('→ 30.0.0');
  expect(await docPage('/nowhere')).toBeUndefined();
  expect((await codePage('X_DB_DRIFT'))?.rows[0]?.cells[0]?.label).toBe('Means');
  expect(await codePage('X_NOPE')).toBeUndefined();
});
