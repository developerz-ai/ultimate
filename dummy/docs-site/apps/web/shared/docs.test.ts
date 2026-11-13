// The corpus, read from this repository's real `wiki/`: the pages, codes and majors every route
// prerenders exist, and every code the framework registers has one (the loader throws otherwise).
// A read that failed is not the answer: the next call reads again.
import { UltimateError } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import { codePage, corpusReader, docPage, docsCorpus } from './docs';

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

unitTest('a first read that failed is not kept: the next call reads again', async () => {
  const real = await docsCorpus();
  let reads = 0;
  const corpus = corpusReader(async () => {
    reads += 1;
    if (reads === 1) {
      // Input, not a verdict: a wiki file that could not be read this once.
      throw new UltimateError({ code: 'X_INVARIANT', cause: 'wiki/ unreadable', fix: 'retry' });
    }
    return real;
  });
  await expect(corpus()).rejects.toBeUltimateError('X_INVARIANT');
  expect(await corpus()).toBe(real);
  expect(reads).toBe(2);
});
