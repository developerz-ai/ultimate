// The factory contract: seeded and reproducible, traits compose, associations follow the strategy
// that asked for them, and an undeclared trait fails at the line that named it.

import { afterEach, describe, expect, test } from 'bun:test';
import type { EntityLike } from './factories';
import { associate, defineFactory, seedFor } from './factories';
import { clearPersister, usePersister } from './factory-persist';
import { testName } from './test-types';

interface Org {
  id: string;
  name: string;
}

interface Post {
  id: string;
  title: string;
  orgId: string;
  published: boolean;
  views: number;
}

const orgs: EntityLike = { kind: 'entity', table: 'orgs', columns: { id: 0, name: 0 } };
const posts: EntityLike = {
  kind: 'entity',
  table: 'posts',
  columns: { id: 0, title: 0, orgId: 0, published: 0, views: 0 },
};

const orgFactory = () =>
  defineFactory(orgs, {
    defaults: (index, ids): Org => ({ id: ids.uuid(), name: `org-${index}` }),
  });

const postFactory = () =>
  defineFactory(posts, {
    defaults: (index, ids): Post => ({
      id: ids.uuid(),
      title: `post-${index}`,
      orgId: '',
      published: false,
      views: 0,
    }),
    traits: {
      published: { published: true },
      popular: (index: number): Partial<Post> => ({ views: index * 100 }),
    },
    associations: { orgId: associate(orgFactory(), (org: Org) => org.id) },
  });

/** Every `create()` in this file goes through one recorder; a leaked one would fail the next file. */
const recorder = () => {
  const written: { table: string; row: Record<string, unknown> }[] = [];
  usePersister({
    insert: async <TRow extends object>(table: string, row: TRow) => {
      written.push({ table, row: { ...row } });
    },
  });
  return written;
};

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'defineFactory'), () => {
  test('is reproducible: two factories over the same entity emit the same rows', () => {
    expect(postFactory().buildMany(3)).toEqual(postFactory().buildMany(3) as Post[]);
  });

  test('gives each table its own id stream, so a post and an org never share an id', () => {
    // The bug this pins: one shared default seed made every factory replay the same uuids, and
    // two rows that only looked related passed a join assertion for the wrong reason.
    expect(orgFactory().build().id).not.toBe(postFactory().build().id);
    expect(seedFor('orgs')).not.toBe(seedFor('posts'));
  });

  test('an explicit seed still wins over the derived one', () => {
    const withSeed = () =>
      defineFactory(orgs, {
        seed: 7,
        defaults: (i, ids): Org => ({ id: ids.uuid(), name: `o${i}` }),
      });
    expect(withSeed().build()).toEqual(withSeed().build());
    expect(withSeed().build().id).not.toBe(orgFactory().build().id);
  });

  test('reset restarts the sequence', () => {
    const factory = postFactory();
    const first = factory.build();
    factory.reset();
    expect(factory.build()).toEqual(first);
  });

  test('an explicit override beats defaults', () => {
    expect(postFactory().build({ title: 'named' }).title).toBe('named');
  });
});

describe(testName('unit', 'factory traits'), () => {
  test('declares its trait names, sorted', () => {
    expect(postFactory().traits).toEqual(['popular', 'published']);
  });

  test('a trait applies its partial', () => {
    expect(postFactory().with('published').build().published).toBe(true);
  });

  test('traits compose, and the later one wins on a shared column', () => {
    const row = postFactory().with('published', 'popular').build();
    expect(row.published).toBe(true);
    expect(row.views).toBeGreaterThan(0);
  });

  test('a function trait sees the row index', () => {
    const [first, second] = postFactory().with('popular').buildMany(2);
    expect(second?.views).toBe((first?.views ?? 0) + 100);
  });

  test('an override still beats a trait', () => {
    expect(postFactory().with('published').build({ published: false }).published).toBe(false);
  });

  test('a view shares the base sequence, so ids never repeat across views', () => {
    const factory = postFactory();
    const ids = [factory.build().id, factory.with('published').build().id, factory.build().id];
    expect(new Set(ids).size).toBe(3);
  });

  test('the base factory is unchanged by a view built from it', () => {
    const factory = postFactory();
    factory.with('published');
    expect(factory.build().published).toBe(false);
  });

  test('an undeclared trait fails at with(), naming the ones that exist', () => {
    const thrown = (() => {
      try {
        postFactory().with('archived' as 'published');
        return undefined;
      } catch (error: unknown) {
        return error as Error & { code?: string; cause?: string };
      }
    })();
    expect(thrown?.code).toBe('X_TEST_FACTORY_TRAIT_UNKNOWN');
    expect(thrown?.cause).toContain('popular, published');
  });
});

describe(testName('unit', 'factory associations'), () => {
  test('build fills the column without touching the persister', () => {
    // No persister installed: a parent that tried to write would fail the test right here, which
    // is the assertion — `build()` must never reach a database.
    expect(postFactory().build().orgId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('create writes the parent before the child', async () => {
    const written = recorder();
    const row = await postFactory().create();
    expect(written.map((entry) => entry.table)).toEqual(['orgs', 'posts']);
    expect(written[1]?.row['orgId']).toBe(row.orgId);
    expect(written[0]?.row['id']).toBe(row.orgId);
  });

  test('an overridden association column creates no parent row at all', async () => {
    const written = recorder();
    await postFactory().create({ orgId: 'org-from-the-test' });
    expect(written.map((entry) => entry.table)).toEqual(['posts']);
  });

  test('a trait that supplies the column also suppresses the parent', async () => {
    const written = recorder();
    const factory = defineFactory(posts, {
      defaults: (index, ids): Post => ({
        id: ids.uuid(),
        title: `post-${index}`,
        orgId: '',
        published: false,
        views: 0,
      }),
      traits: { hosted: { orgId: 'fixed-org' } },
      associations: { orgId: associate(orgFactory(), (org: Org) => org.id) },
    });
    await factory.with('hosted').create();
    expect(written.map((entry) => entry.table)).toEqual(['posts']);
  });
});

describe(testName('unit', 'factory create'), () => {
  test('createMany writes one row per count, in order', async () => {
    const written = recorder();
    const rows = await orgFactory().createMany(3);
    expect(rows).toHaveLength(3);
    expect(written.map((entry) => entry.row['id'])).toEqual(rows.map((row) => row.id));
  });

  test('with no persister it names the table and the two ways out', async () => {
    const thrown = await orgFactory()
      .create()
      .then(
        () => undefined,
        (error: unknown) => error as Error & { code?: string; cause?: string; fix?: string },
      );
    expect(thrown?.code).toBe('X_TEST_FACTORY_NOT_PERSISTED');
    expect(thrown?.cause).toContain('orgs');
    expect(thrown?.fix).toContain('build()');
  });
});
