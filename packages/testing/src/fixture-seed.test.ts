// The `seed` fixture: a named seed runs into the APP's driver once per test, its rows come back by
// label, a replay in the next test writes nothing and still finds every label, and an unknown seed
// or label is refused by name.

import { afterEach, describe, expect } from 'bun:test';
import { memoryDriver } from '@ultimat3/entity';
import { factoryWorld, orgs } from './factory-fixture';
import { clearPersister } from './factory-persist';
import { seedFixture } from './fixture-seed';
import { factorySeed } from './seed-factories';
import { unitTest } from './test-types';

afterEach(() => {
  clearPersister();
});

const { orgFactory, postFactory } = factoryWorld();
clearPersister();
const demo = factorySeed('demo', async ({ id }) => {
  const org = await orgFactory.create({ id: id('org:acme'), name: 'Acme' });
  await postFactory.create({ id: id('post:hello'), org });
});

const appDriver = memoryDriver();
const seedFor = seedFixture({ seeds: [demo], driver: () => appDriver });

describe('seed fixture', () => {
  unitTest('runs the named seed into the app driver and picks rows by label', async () => {
    const seed = seedFor();
    const { acme, hello } = await seed('demo').pick({ acme: 'org:acme', hello: 'post:hello' });
    expect(acme['name']).toBe('Acme');
    expect(hello['orgId']).toBe(acme.id);
    expect((await appDriver.repo(orgs).findMany()).rows.map((row) => row.id)).toEqual([acme.id]);
    expect((await seed('demo').ran).metrics.inserted).toBe(2);
  });

  unitTest('one run per test: a second seed(name) is the same handle', () => {
    const seed = seedFor();
    expect(seed('demo')).toBe(seed('demo'));
  });

  unitTest('a replay writes nothing and still finds every label', async () => {
    const handle = seedFor()('demo');
    expect((await handle.ran).metrics.inserted).toBe(0);
    const { acme } = await handle.pick({ acme: 'org:acme' });
    expect(acme['name']).toBe('Acme');
  });

  unitTest('an unknown seed or label is refused by name', async () => {
    const seed = seedFor();
    expect(() => seed('prod')).toThrow(/no seed named "prod".*known: demo/);
    await expect(seed('demo').pick({ who: 'org:nobody' })).rejects.toThrow(
      /wrote no row labelled "org:nobody"/,
    );
  });
});
