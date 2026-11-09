// The factory lint: a valid factory set is silent; a factory (or one trait of it) that builds a row
// its entity refuses is named with the entity's own code, on the strategy that hit it — and the
// lint leaves the suite's persister, rows and sequences as it found them.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineFactory } from './factories';
import { factoryWorld, orgs, posts } from './factory-fixture';
import { assertFactoriesValid, lintFactories } from './factory-lint';
import { clearPersister } from './factory-persist';
import { testName } from './test-types';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'factory lint'), () => {
  test('a valid set has no findings, and the suite keeps its driver and its sequence', async () => {
    const { driver, orgFactory, postFactory, commentFactory } = factoryWorld();
    postFactory.build();
    expect(await lintFactories({ orgFactory, postFactory, commentFactory })).toEqual([]);
    expect((await driver.repo(orgs).findMany()).rows).toEqual([]);
    // Restarted after the lint, not left where it stopped.
    expect(postFactory.build().title).toBe('post-1');
  });

  test('a trait that breaks a column is named, with the entity code, on both strategies', async () => {
    const { postFactory } = factoryWorld();
    const broken = postFactory.extend({ traits: { untitled: { title: 'x'.repeat(200) } } });
    const findings = await lintFactories({ posts: broken });
    expect(findings.map((one) => [one.trait, one.strategy])).toEqual([
      ['untitled', 'build'],
      ['untitled', 'create'],
    ]);
    expect(findings[0]?.code).toMatch(/^X_/);
    expect(findings[0]?.code).not.toBe('X_TEST_FACTORY_INVALID');
  });

  test('a built key the entity does not declare is X_TEST_FACTORY_INVALID', async () => {
    const stray = defineFactory(orgs, {
      // A column that was renamed away: the row still builds, the key goes nowhere.
      defaults: (n, ids) => ({ id: ids.uuid(), name: `o${n}`, legacyName: 'x' }) as never,
    });
    const [finding] = await lintFactories({ stray });
    expect(finding).toEqual({
      factory: 'stray',
      trait: null,
      strategy: 'build',
      code: 'X_TEST_FACTORY_INVALID',
      cause: 'ff_orgs declares no column legacyName',
    });
  });

  test('assertFactoriesValid throws one coded error listing every finding', async () => {
    const empty = defineFactory(posts, {
      defaults: (_, ids) => ({ id: ids.uuid(), orgId: ids.uuid(), title: '' }) as never,
      traits: { missing: { title: undefined } as never },
    });
    const thrown = await assertFactoriesValid({ empty }).then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string; cause?: string; fix?: string },
    );
    expect(thrown?.code).toBe('X_TEST_FACTORY_INVALID');
    expect(thrown?.cause).toContain("empty.with('missing').build()");
    expect(thrown?.fix).toContain('defineFactory');
  });
});
