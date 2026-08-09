/**
 * contract — schema round-trip, policy denials, and the projected surfaces (OpenAPI + MCP tool).
 * Runs against a cloned database with a frozen clock and a sealed network.
 *
 * Importing `../../api` is the boot: it registers every module, which is what stamps the export
 * name onto each declaration. Without it a projection has no stable name to project under.
 */

import { contractTest, expect, test } from '@ultimat3/testing';
import '../../api';
import { createComment, createPost, publishPost } from './actions';

const ORG = '00000000-0000-4000-8000-000000000002';

test('publishPost round-trips its schema and applies the default', async ({ seed, actorFor }) => {
  const { draft, author } = await seed('dev').pick({
    draft: 'post:draft-money',
    author: 'member:bruno',
  });

  const published = await publishPost.as(actorFor(author), {
    postId: draft.id,
    orgId: draft.orgId,
  });

  expect(published.status).toBe('published');
  expect(published.publishedAt).not.toBeNull();
  // `notify` defaults to true, so the fanout job exists — in the same transaction as the write.
  expect(publishPost.input.parse({ postId: draft.id, orgId: draft.orgId })).toEqual({
    postId: draft.id,
    orgId: draft.orgId,
    notify: true,
  });
});

test('publishPost denies a member of another org', async ({ seed, actorFor }) => {
  const { draft, stranger } = await seed('dev').pick({
    draft: 'post:draft-money',
    stranger: 'member:mara',
  });

  await expect(
    publishPost.as(actorFor(stranger), { postId: draft.id, orgId: draft.orgId }),
  ).rejects.toMatchError('X_POLICY_DENIED');
});

test('publishPost denies an author who does not own the post and is not an admin', async ({
  seed,
  actorFor,
}) => {
  const { draft, reader } = await seed('dev').pick({
    draft: 'post:draft-money',
    reader: 'member:kenji',
  });

  await expect(
    publishPost.as(actorFor(reader), { postId: draft.id, orgId: draft.orgId }),
  ).rejects.toMatchError('X_POLICY_DENIED');
});

test('publishing twice keeps the original instant', async ({ seed, actorFor, clock }) => {
  const { draft, owner } = await seed('dev').pick({
    draft: 'post:draft-money',
    owner: 'member:ada', // org admin: owns-or-org-admin is the rule, not owns-only
  });

  const input = { postId: draft.id, orgId: draft.orgId, notify: false };
  const first = await publishPost.as(actorFor(owner), input);
  clock.advance('1h');
  const second = await publishPost.as(actorFor(owner), input);

  expect(second.publishedAt).toEqual(first.publishedAt);
});

test('createPost derives the slug and the excerpt instead of trusting input', async ({
  seed,
  actorFor,
}) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' });

  const post = await createPost.as(actorFor(author), {
    orgId: author.orgId,
    title: 'Ship the boring 40%',
    body: 'x'.repeat(600),
  });

  expect(post.slug).toBe('ship-the-boring-40');
  expect(post.excerpt.length).toBeLessThanOrEqual(200);
  expect(post.status).toBe('draft');
});

contractTest('every post action rejects input that is not a uuid', async () => {
  await expect(publishPost.input).toRejectInput({ postId: 'not-a-uuid', orgId: ORG });
  await expect(createComment.input).toRejectInput({ postId: ORG, orgId: ORG, body: '' });
});

contractTest('every post action passes the contract an action owes', async () => {
  // Three assertions the framework makes for any action without knowing what it does: garbage
  // input is rejected, an anonymous actor is denied, and the operation reaches OpenAPI.
  for (const action of [createPost, publishPost, createComment]) {
    for (const contract of action.contract()) await contract.run();
  }
});

contractTest(
  'the action projects the MCP tool and the OpenAPI operation from one declaration',
  () => {
    expect(publishPost.mcp).toEqual({ expose: true, description: 'Publish a draft post' });
    // Same policy object on both surfaces — an MCP call cannot reach a different authz path.
    expect(publishPost.tool().policy).toBe(publishPost.policy);
    expect(publishPost.openapi().operationId).toBe('publishPost');
  },
);
