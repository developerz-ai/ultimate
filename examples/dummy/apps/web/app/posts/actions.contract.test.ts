/**
 * contract — schema round-trip, policy denials, and the projected surfaces (OpenAPI + MCP tool).
 * Runs against a cloned database with a frozen clock and a sealed network.
 *
 * Registration happens in `scripts/test-setup.ts`, the preload: it boots `apps/web/api`, which
 * stamps each export name onto its declaration and gives every projection a stable name. This
 * file does not import `api/` — a test in `app/` importing it at runtime is the boundary
 * violation `x verify` rejects, and the preload runs before every suite anyway.
 */

import { contractTest, expect, test } from '@ultimat3/testing';
import { createComment, createPost, publishPost } from './actions';

const ORG = '00000000-0000-4000-8000-000000000002';
const NOT_A_UUID = 'not-a-uuid';

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
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('publishPost denies an author who does not own the post and is not an admin', async ({
  seed,
  actorFor,
}) => {
  // Bruno is an `author`: he HOLDS `post:publish`, in this org, and did not write this post. That
  // combination is the only one that exercises the ownership branch — a reader is turned away by
  // the grant check before any predicate runs, so it would pass this test without proving it.
  const { post, author } = await seed('dev').pick({
    post: 'post:tenancy', // written by Ada
    author: 'member:bruno',
  });

  await expect(
    publishPost.as(actorFor(author), { postId: post.id, orgId: post.orgId }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('a post in another org is invisible rather than publishable', async ({ seed, actorFor }) => {
  // Actor and input `orgId` are both Acme's; only the post is Tinta's. The tenancy half of the
  // rule reads `input`, so it passes — what stops the call is the row: `postPublish` compares the
  // loaded post's org and denies, and it does so before the handler and before any write.
  const { foreign, acme, author } = await seed('dev').pick({
    foreign: 'post:offline',
    acme: 'org:acme',
    author: 'member:bruno',
  });

  await expect(
    publishPost.as(actorFor(author), { postId: foreign.id, orgId: acme.id }),
  ).rejects.toBeUltimateError('X_FORBIDDEN');
});

test('a cross-org post id is a miss, not a comment on someone else’s post', async ({
  seed,
  actorFor,
}) => {
  // `postRead` decides on input alone, so authz genuinely passes here: the actor is reading its
  // own org. The tenancy enforcement is one layer lower — `ctx.posts.comment` goes through
  // `byId`, which is scoped to `ctx.actor.orgId` and finds nothing. The point of this case is to
  // pin that a foreign post id is INVISIBLE, so the failure names the id and not the actor.
  const { foreign, acme, reader } = await seed('dev').pick({
    foreign: 'post:offline',
    acme: 'org:acme',
    reader: 'member:kenji',
  });

  await expect(
    createComment.as(actorFor(reader), {
      postId: foreign.id,
      orgId: acme.id,
      body: 'commenting across a tenant boundary',
    }),
  ).rejects.toBeUltimateError('X_POST_NOT_FOUND');
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
  // Every payload below is valid except for exactly one id, and each action's fully valid payload
  // is asserted first. Without that control the case proves nothing: the old version rejected a
  // comment whose `body` was `''`, which `min(1)` catches, so it would have kept passing with the
  // uuid parser removed entirely.
  const post = { title: 'Ship the boring 40%', body: 'x'.repeat(600) };
  await expect(createPost.input).toAcceptInput({ ...post, orgId: ORG });
  await expect(createPost.input).toRejectInput({ ...post, orgId: NOT_A_UUID });

  await expect(publishPost.input).toAcceptInput({ postId: ORG, orgId: ORG });
  await expect(publishPost.input).toRejectInput({ postId: NOT_A_UUID, orgId: ORG });
  await expect(publishPost.input).toRejectInput({ postId: ORG, orgId: NOT_A_UUID });

  const comment = { body: 'a body that is long enough to be valid' };
  await expect(createComment.input).toAcceptInput({ ...comment, postId: ORG, orgId: ORG });
  await expect(createComment.input).toRejectInput({ ...comment, postId: NOT_A_UUID, orgId: ORG });
  await expect(createComment.input).toRejectInput({ ...comment, postId: ORG, orgId: NOT_A_UUID });
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
