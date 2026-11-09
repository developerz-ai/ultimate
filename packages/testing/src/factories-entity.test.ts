// A factory takes the value `entity()` returns, not a lookalike: both entry points that read one,
// `defineFactory` and `factoriesFor`, held to a real entity, a renamed table included.

import { afterEach, describe, expect, test } from 'bun:test';
import { boolean, entity, integer, text, uuid } from '@ultimat3/entity';
import { defineFactory, seedFor } from './factories';
import { belongsTo } from './factory-associations';
import { clearPersister, usePersister } from './factory-persist';
import { factoriesFor } from './factory-registry';
import { testName } from './test-types';

const org = entity('org', {
  table: 'legacy_orgs',
  columns: { id: uuid().primaryKey(), name: text() },
});
const post = entity('posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().references(() => org.id),
    title: text(),
    published: boolean().default(false),
    views: integer().default(0),
  },
});

const written: string[] = [];

afterEach(() => {
  clearPersister();
  written.length = 0;
});

const record = (): void =>
  usePersister({
    insert: async (entity, row) => {
      written.push(entity.$table);
      return row;
    },
  });

describe(testName('unit', 'factories over a real entity'), () => {
  test('defineFactory builds, seeds from the table and creates through the persister', async () => {
    const orgs = defineFactory(org, {
      defaults: (index, ids) => ({ id: ids.uuid(), name: `org-${index}` }),
    });
    const posts = defineFactory(post, {
      defaults: (index, ids) => ({
        id: ids.uuid(),
        orgId: '',
        title: `post-${index}`,
        published: false,
        views: 0,
      }),
      belongsTo: { org: belongsTo(orgs, 'orgId') },
    });
    expect(orgs.table).toBe('legacy_orgs');
    expect(orgs.build().name).toBe('org-1');
    expect(seedFor('legacy_orgs')).not.toBe(seedFor('posts'));
    record();
    const created = await posts.create();
    expect(written).toEqual(['legacy_orgs', 'posts']);
    expect(typeof created.orgId).toBe('string');
  });

  test('factoriesFor fills every declared column of a real entity', async () => {
    const made = factoriesFor({ org, post });
    expect(Object.keys(made.post.build()).sort()).toEqual(
      ['id', 'orgId', 'published', 'title', 'views'].sort(),
    );
    record();
    await made.org.create();
    expect(written).toEqual(['legacy_orgs']);
  });
});
