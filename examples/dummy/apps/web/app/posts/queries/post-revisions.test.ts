// `postRevisions` reads `posts_history`, which the `history` declaration on `posts` keeps: a write
// through the app is a version the post's readers can list, newest first — and only its own org's.

import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { likePost } from '../actions/like-post';
import { movePostStatus } from '../actions/move-post-status';
import type { PostRevision } from '../entity';
import { postRevisions } from './post-revisions';

test('a status change is the newest revision, and another org reads no revision of it', async ({
  seed,
  actorFor,
}) => {
  const { draft, ada, mara } = await seed('dev').pick({
    draft: 'post:draft-money', // Acme's, Bruno's draft
    ada: 'member:ada', // Acme's owner
    mara: 'member:mara', // Tinta's owner
  });
  await movePostStatus.as(actorFor(ada), { id: draft.id, from: 'draft', to: 'scheduled' });

  const read = async (as: typeof ada, orgId: string) => {
    const server = httpServer({
      routes: [toQueryRoute(postRevisions)],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
      hooks: { authenticate: () => actorFor(as) },
    });
    const url = `http://dev.test/_x/query/post-revisions?orgId=${orgId}&postId=${draft.id}`;
    return server.fetch(new Request(url));
  };

  const mine = await read(ada, ada.orgId);
  expect(mine.status).toBe(200);
  const revisions = (await mine.json()) as readonly PostRevision[];
  expect(revisions.map((revision) => [revision.op, revision.status])).toEqual([
    ['update', 'scheduled'],
    ['insert', 'draft'],
  ]);
  expect(revisions.map((revision) => revision.version)).toEqual([2, 1]);

  // Mara asking about Acme's post is refused by the post's own read rule…
  expect((await read(mara, ada.orgId)).status).toBe(403);
  // …and asking in her own org, the history read is Tinta's: Acme's post has none there.
  const theirs = await read(mara, mara.orgId);
  expect(await theirs.json()).toEqual([]);
});

test('a like moves the count and records no revision', async ({ seed, actorFor }) => {
  // Ada has not liked her own post in the seed (Bruno and Kenji have): this like is a real write.
  const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });
  const server = httpServer({
    routes: [toQueryRoute(postRevisions)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const revisions = async (): Promise<readonly PostRevision[]> =>
    (await (
      await server.fetch(
        new Request(
          `http://dev.test/_x/query/post-revisions?orgId=${post.orgId}&postId=${post.id}`,
        ),
      )
    ).json()) as readonly PostRevision[];
  const before = await revisions();

  const liked = await likePost.as(actorFor(ada), { postId: post.id, orgId: post.orgId });

  // Bruno's and Kenji's seeded likes, counted by the database as they were written, and this one.
  // Not `post.likeCount + 1`: the seed's row is as inserted, before any like counted into it.
  expect(liked.likeCount).toBe(3);
  // `history: { ignore: ['likeCount', 'updatedAt'] }`: the write that changed only those is no version.
  expect(await revisions()).toEqual(before);
});
