// A seed built from factories is a seed: named, tiered, runnable by `x db seed` (`isSeed`), and
// IDEMPOTENT — a second run writes nothing new and the rows are byte-identical (`digestRow`).

import { afterEach, describe, expect, test } from 'bun:test';
import { isSeed, memoryDriver } from '@ultimat3/entity';
import { comments, factoryWorld, orgs, posts } from './factory-fixture';
import { clearPersister, persisterInstalled } from './factory-persist';
import { factorySeed } from './seed-factories';
import { digestRow } from './seed-writer';
import { testName } from './test-types';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'factorySeed'), () => {
  const { orgFactory, postFactory } = factoryWorld();
  clearPersister();
  const demo = factorySeed('demo', async ({ id }) => {
    const org = await orgFactory.create({ id: id('org:acme'), name: 'Acme' });
    await postFactory.createList(2, { org, comments: 2 });
  });

  const rowsOf = async (driver: ReturnType<typeof memoryDriver>): Promise<readonly string[]> => {
    const [org] = (await driver.repo(orgs).findMany()).rows;
    const scope = { orgId: org?.id ?? '' };
    const all = [
      ...(await driver.repo(orgs).findMany()).rows,
      ...(await driver.repo(posts).findMany(scope)).rows,
      ...(await driver.repo(comments).findMany(scope)).rows,
    ];
    return all.map(digestRow);
  };

  test('is a seed x db seed can pick up, dev tier by default', () => {
    expect(isSeed(demo)).toBe(true);
    expect(demo.tier).toBe('dev');
  });

  test('writes the factory graph through the given driver', async () => {
    const driver = memoryDriver();
    const run = await demo.run({ driver });
    expect(run.metrics.inserted).toBe(1 + 2 + 4);
    expect(await rowsOf(driver)).toHaveLength(7);
  });

  test('a replay writes nothing new and leaves every row byte-identical', async () => {
    const driver = memoryDriver();
    await demo.run({ driver });
    const before = await rowsOf(driver);
    // Sequences moved on since — by this file's other tests and by a stray build here.
    postFactory.buildList(5);
    const again = await demo.run({ driver });
    expect(again.metrics).toEqual({ inserted: 0, updated: 0, skipped: 7 });
    expect(await rowsOf(driver)).toEqual(before);
  });

  test('hands the persister back as it found it', async () => {
    await demo.run({ driver: memoryDriver() });
    expect(persisterInstalled()).toBe(false);
  });
});
