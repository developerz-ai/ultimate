// `orgPosts` pages to its last row: its provider is handed the cursor and the window
// (`RowWindow`), so page two is read past page one — never cut out of the same first window.
// 55 posts sharing ONE instant make the `id` tiebreak decide every position: a provider that read
// "the newest 50" by `createdAt` alone served the wrong 50 and the walk lost rows.

import { db } from '@postly/db';
import { expect, test } from '@ultimat3/testing';
import { ORG_POSTS_MAX, orgPosts } from './org-posts';

const AT = new Date('2027-01-01T00:00:00Z');

test('walking orgPosts five at a time serves its whole listing, once each', async ({
  seed,
  actorFor,
}) => {
  const { ada } = await seed('dev').pick({ ada: 'member:ada' });
  const made = await db.posts.insertAll(
    Array.from({ length: 55 }, (_, n) => ({
      orgId: ada.orgId,
      authorId: ada.id,
      slug: `window-${n}`,
      title: `Window ${n}`,
      excerpt: `Excerpt ${n}`,
      body: `Body ${n}`,
      createdAt: AT,
      updatedAt: AT,
    })),
  );
  const actor = actorFor(ada);

  const served: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await orgPosts.page(
      { orgId: ada.orgId },
      { first: 5, actor, ...(after === undefined ? {} : { after }) },
    );
    served.push(...page.rows.map((row) => row.id));
    if (page.nextCursor === null) break;
    after = page.nextCursor;
  }

  // Newest first, the id breaking the tie: every made post is newer than the seed's.
  const expected = made
    .map((post) => post.id)
    .sort()
    .slice(0, ORG_POSTS_MAX);
  expect(served).toEqual(expected);
});
