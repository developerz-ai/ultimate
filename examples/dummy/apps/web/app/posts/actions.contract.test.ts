/**
 * contract — schema round-trip, policy denials, and the projected surfaces (OpenAPI + MCP tool).
 * Runs against a cloned database with a frozen clock and a sealed network.
 */

import { expect, test } from '@ultimat3/testing';
import { createPost, publishPost } from './actions';

test('publishPost round-trips its schema and applies the default', async ({ seed, actorFor }) => {
  const { draft, author } = await seed('dev').pick({
    draft: 'post:draft-money',
    author: 'member:bruno',
  });

  const published = await publishPost.as(actorFor(author), { postId: draft.id });

  expect(published.status).toBe('published');
  expect(published.publishedAt).not.toBeNull();
  // `notify` defaults to true, so the fanout job exists — in the same transaction as the write.
  expect(await publishPost.input.assert({ postId: draft.id })).toEqual({
    postId: draft.id,
    notify: true,
  });
});

test('publishPost denies a member of another org', async ({ seed, actorFor }) => {
  const { draft, stranger } = await seed('dev').pick({
    draft: 'post:draft-money',
    stranger: 'member:mara',
  });

  await expect(publishPost.as(actorFor(stranger), { postId: draft.id })).rejects.toMatchError(
    'X_POLICY_DENIED',
  );
});

test('publishPost denies an author who does not own the post and is not an admin', async ({
  seed,
  actorFor,
}) => {
  const { draft, reader } = await seed('dev').pick({
    draft: 'post:draft-money',
    reader: 'member:kenji',
  });

  await expect(publishPost.as(actorFor(reader), { postId: draft.id })).rejects.toMatchError(
    'X_POLICY_DENIED',
  );
});

test('publishing twice keeps the original instant', async ({ seed, actorFor, clock }) => {
  const { draft, owner } = await seed('dev').pick({
    draft: 'post:draft-money',
    owner: 'member:ada', // org admin: owns-or-org-admin is the rule, not owns-only
  });

  const first = await publishPost.as(actorFor(owner), { postId: draft.id, notify: false });
  clock.advance('1h');
  const second = await publishPost.as(actorFor(owner), { postId: draft.id, notify: false });

  expect(second.publishedAt).toEqual(first.publishedAt);
});

test('createPost derives the slug and the excerpt instead of trusting input', async ({
  seed,
  actorFor,
}) => {
  const { author } = await seed('dev').pick({ author: 'member:bruno' });

  const post = await createPost.as(actorFor(author), {
    title: 'Ship the boring 40%',
    body: 'x'.repeat(600),
  });

  expect(post.slug).toBe('ship-the-boring-40');
  expect(post.excerpt.length).toBeLessThanOrEqual(200);
  expect(post.status).toBe('draft');
});

test('the action projects the MCP tool and the OpenAPI operation from one declaration', () => {
  expect(publishPost.mcp).toEqual({ expose: true, description: 'Publish a draft post' });
  // Same policy object on both surfaces — an MCP call cannot reach a different authz path.
  expect(publishPost.tool().policy).toBe(publishPost.policy);
  expect(publishPost.openapi().operationId).toBe('publishPost');
});
