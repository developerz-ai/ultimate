// Postly's factories, exercised: every factory builds and creates a row its entity stores, and
// one graph — a published post, its comments, one org — shares its tenant.
import { describe, expect, test } from 'bun:test';
import { assertFactoriesValid } from '@ultimat3/testing';
import { factories, orgFactory, postFactory } from './factories';

describe('postly factories', () => {
  test('every factory builds and creates rows its entity stores', async () => {
    await assertFactoriesValid(factories);
  });
  test('a published post with two comments, all in one org; an org reused', async () => {
    const post = await postFactory.with('published').create({ comments: 2 });
    expect(post.status).toBe('published');
    expect(post.likeCount).toBe(0); // the stored row: the entity's default
    expect(post.comments.map((c) => c.orgId)).toEqual([post.orgId, post.orgId]);
    const org = await orgFactory.create();
    const [a, b] = await postFactory.createList(2, { org });
    expect([a?.orgId, b?.orgId]).toEqual([org.id, org.id]);
    expect(postFactory.attributesFor()).not.toHaveProperty('id');
  });
});
