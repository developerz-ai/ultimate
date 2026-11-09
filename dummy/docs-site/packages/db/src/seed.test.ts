// The seed as `x db seed` finds it: a declared `defineSeed()` under this app's name, which
// writes nothing until an entity exists. The day it inserts a row, the last assertion says so.
import { isSeed } from '@ultimat3/entity';
import { expect, unitTest } from '@ultimat3/testing';
import { driver } from './client';
import { docsSiteSeed } from './seed';

unitTest('the seed is one x db seed discovers, in the dev tier', () => {
  expect(isSeed(docsSiteSeed)).toBe(true);
  expect(docsSiteSeed.name).toBe('docs-site');
  // `dev`: fixture data, never loaded into production. `reference` is the other tier.
  expect(docsSiteSeed.tier).toBe('dev');
});

unitTest('it writes nothing yet', async () => {
  const run = await docsSiteSeed.run({ driver });
  expect(run.metrics).toEqual({ inserted: 0, updated: 0, skipped: 0 });
});
