// `postLikesByDay` buckets a post's likes by the READER's day: the seed's two likes on
// `post:tenancy` (14:00 UTC on 2 March, 01:10 UTC on 3 March) are one day in New York and two
// in Tokyo. Through the query's own route, so the policy and the zone check are the ones served.

import type { Actor } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { expect, test } from '@ultimat3/testing';
import { postLikesByDay } from './post-likes-by-day';

interface PostRef {
  readonly orgId: string;
  readonly id: string;
}

const read = (actor: Actor, post: PostRef, timeZone: string): Promise<Response> => {
  const server = httpServer({
    routes: [toQueryRoute(postLikesByDay)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actor },
  });
  const query = new URLSearchParams({ orgId: post.orgId, postId: post.id, timeZone });
  return server.fetch(new Request(`http://dev.test/_x/query/post-likes-by-day?${query}`));
};

const days = async (response: Response) =>
  ((await response.json()) as readonly { day: string; likes: number }[]).map((row) => [
    row.day,
    row.likes,
  ]);

test('two likes eleven hours apart are one day in New York', async ({ seed, actorFor }) => {
  const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });
  const response = await read(actorFor(ada), post, 'America/New_York');
  expect(response.status).toBe(200);
  // Local midnight of 2 March in New York (UTC-5 until the 8th), as an instant.
  expect(await days(response)).toEqual([['2026-03-02T05:00:00.000Z', 2]]);
});

test('the same two likes are two days in Tokyo, newest first', async ({ seed, actorFor }) => {
  const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });
  const response = await read(actorFor(ada), post, 'Asia/Tokyo');
  expect(await days(response)).toEqual([
    ['2026-03-02T15:00:00.000Z', 1],
    ['2026-03-01T15:00:00.000Z', 1],
  ]);
});

test('a zone outside the settings list is refused at the input, never guessed', async ({
  seed,
  actorFor,
}) => {
  const { post, ada } = await seed('dev').pick({ post: 'post:tenancy', ada: 'member:ada' });
  const response = await read(actorFor(ada), post, 'America/Los_Angeles');
  expect(response.status).toBe(400);
  expect(((await response.json()) as { code: string }).code).toBe('X_INPUT_INVALID');
});

test('another org’s member reads nothing of this post', async ({ seed, actorFor }) => {
  const { post, mara } = await seed('dev').pick({ post: 'post:tenancy', mara: 'member:mara' });
  const response = await read(actorFor(mara), post, 'UTC');
  expect(response.status).toBe(403);
});
