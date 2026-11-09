// Associations over real entities on the memory driver: a parent made with the child's strategy, a
// parent row reused, children made after the parent with the key set, and the tenant column
// following the parent — one org per graph, never two.

import { afterEach, describe, expect, test } from 'bun:test';
import { defineFactory } from './factories';
import { belongsTo, hasMany } from './factory-associations';
import { comments, factoryWorld, orgs, posts } from './factory-fixture';
import { clearPersister } from './factory-persist';
import { testName } from './test-types';

afterEach(() => {
  clearPersister();
});

describe(testName('unit', 'factory belongsTo'), () => {
  test('build makes the parent in memory and writes nothing', async () => {
    const { driver, postFactory } = factoryWorld();
    const post = postFactory.build();
    expect(post.orgId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await driver.repo(orgs).findMany()).rows).toEqual([]);
  });

  test('create writes the parent first and keys the child to the STORED parent', async () => {
    const { driver, postFactory } = factoryWorld();
    const post = await postFactory.create();
    const org = await driver.repo(orgs).findById(post.orgId);
    expect(org?.name).toBe('org-1');
    expect(await driver.repo(posts).findById(post.id, { orgId: post.orgId })).toEqual(post);
  });

  test('create({ org: row }) reuses that row and makes no other', async () => {
    const { driver, orgFactory, postFactory } = factoryWorld();
    const org = await orgFactory.create();
    const [first, second] = await postFactory.createList(2, { org });
    expect([first?.orgId, second?.orgId]).toEqual([org.id, org.id]);
    expect((await driver.repo(orgs).findMany()).rows).toHaveLength(1);
  });

  test('an explicit key makes no parent at all', async () => {
    const { driver, orgFactory, postFactory } = factoryWorld();
    const org = await orgFactory.create();
    await postFactory.create({ orgId: org.id });
    expect((await driver.repo(orgs).findMany()).rows).toHaveLength(1);
  });

  test('the tenant follows the parent: a comment, its post and its org share one org', async () => {
    const { driver, commentFactory } = factoryWorld();
    const comment = await commentFactory.create();
    const post = await driver.repo(posts).findById(comment.postId, { orgId: comment.orgId });
    expect(post?.orgId).toBe(comment.orgId);
    expect((await driver.repo(orgs).findMany()).rows).toHaveLength(1);
  });

  test('a tenant the call names is the tenant every auto-made parent is made in', async () => {
    const { commentFactory, orgFactory } = factoryWorld();
    const org = orgFactory.build();
    const comment = commentFactory.build({ orgId: org.id });
    expect(comment.orgId).toBe(org.id);
    // The post was built for this comment, in the comment's tenant.
    expect(comment.postId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe(testName('unit', 'factory hasMany'), () => {
  test('a count makes that many children, after the parent, keyed and in its tenant', async () => {
    const { driver, postFactory } = factoryWorld();
    const post = await postFactory.create({ comments: 2 });
    expect(post.comments).toHaveLength(2);
    for (const comment of post.comments) {
      expect([comment.postId, comment.orgId]).toEqual([post.id, post.orgId]);
    }
    const stored = await driver.repo(comments).findMany({ orgId: post.orgId });
    expect(stored.rows).toHaveLength(2);
    // The comments reused the post and its org: no second org was made for them.
    expect((await driver.repo(orgs).findMany()).rows).toHaveLength(1);
  });

  test('a list of overrides makes one child each, the overrides applied', async () => {
    const { postFactory } = factoryWorld();
    const post = await postFactory.create({ comments: [{ body: 'first' }, { body: 'second' }] });
    expect(post.comments.map((comment) => comment.body)).toEqual(['first', 'second']);
  });

  test('none is asked for by default, and build makes children in memory', async () => {
    const { driver, postFactory } = factoryWorld();
    expect((await postFactory.create()).comments).toEqual([]);
    const built = postFactory.build({ comments: 1 });
    expect(built.comments[0]?.postId).toBe(built.id);
    expect((await driver.repo(comments).findMany({ orgId: built.orgId })).rows).toEqual([]);
  });
});

describe(testName('unit', 'factory types'), () => {
  test('a key that is not a column, or a value of the wrong kind, does not compile', () => {
    const { orgFactory } = factoryWorld();
    defineFactory(posts, {
      // @ts-expect-error — `belongsTo` names `authorId`, which the defaults do not build.
      defaults: (n, ids) => ({ id: ids.uuid(), orgId: '', title: `p${n}` }),
      belongsTo: { org: belongsTo(orgFactory, 'authorId') },
    });
    defineFactory(posts, {
      // @ts-expect-error — `views` is an integer column.
      defaults: (_, ids) => ({ id: ids.uuid(), orgId: '', title: 't', views: 'many' }),
    });
    const commentsOnly = defineFactory(comments, {
      defaults: () => ({ id: '', orgId: '', postId: '', body: '' }),
    });
    // @ts-expect-error — `hasMany` keys the CHILD's column, and comments have no `ownerId`.
    hasMany(commentsOnly, 'ownerId');
    expect(orgFactory.table).toBe('ff_orgs');
  });
});

// A parent the caller hands over decides the tenant, even when the tenant column has a factory of
// its own: `comment.create({ post })` once made a NEW org first and wrote { orgId: C, postId: a post
// in A } — a foreign-key violation on create, and a silently cross-tenant row on build.
describe(testName('unit', 'a supplied parent decides the tenant'), () => {
  test('create: the comment is in the post’s org, and no second org is made', async () => {
    const { driver, postFactory, commentFactory } = factoryWorld();
    const post = await postFactory.create();
    const comment = await commentFactory.create({ post });
    expect(comment.orgId).toBe(post.orgId);
    expect(comment.postId).toBe(post.id);
    expect((await driver.repo(orgs).findMany()).rows).toHaveLength(1);
  });

  test('build: the same tenant, in memory', () => {
    const { postFactory, commentFactory } = factoryWorld();
    const post = postFactory.build();
    const comment = commentFactory.build({ post });
    expect(comment.orgId).toBe(post.orgId);
  });
});
