// `postBySlug` is a lookup by slug: a miss is a 404, and the miss is held for `negativeTtlMs`, not
// the row's five minutes. A slug asked for just before its post lands says "absent" for seconds.
// Over a real in-process tier and the frozen clock, so the lease is the cache's own expiry.

import { db, driver } from '@postly/db';
import { isolateTiers, lruTier, registerTier } from '@ultimat3/cache';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { toQueryRoute } from '@ultimat3/query';
import { afterAll, afterEach, expect, test } from '@ultimat3/testing';
import { postBySlug } from './post-by-slug';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});
// The published draft is this file's, never another file's fixture: the store is process-wide.
afterAll(() => {
  driver.reset?.();
});

test('a miss is held for negativeTtlMs, then the published post answers', async ({
  seed,
  actorFor,
  clock,
}) => {
  restore = isolateTiers();
  // The full lease, unjittered: the claim is where it ends, to the millisecond.
  registerTier(lruTier({ jitterFraction: 0 }));
  // Acme's draft: its slug misses until it is published, which is the lookup this lease is for.
  const { ada, draft } = await seed('dev').pick({ ada: 'member:ada', draft: 'post:draft-money' });
  const server = httpServer({
    routes: [toQueryRoute(postBySlug)],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    hooks: { authenticate: () => actorFor(ada) },
  });
  const read = () =>
    server.fetch(
      new Request(`http://dev.test/_x/query/post-by-slug?orgId=${ada.orgId}&slug=${draft.slug}`),
    );

  expect((await read()).status).toBe(404);
  // Written past the action, so no tag is dropped: only the lease can end the cached miss.
  await db.posts.update(
    draft.id,
    { status: 'published', publishedAt: clock.now() },
    { orgId: draft.orgId },
  );
  expect((await read()).status).toBe(404);

  // Under the row's 300 s by far, and only just past the null's 5 s.
  clock.advance(4_999);
  expect((await read()).status).toBe(404);
  clock.advance(2);
  const landed = await read();
  expect(landed.status).toBe(200);
  // `single: true`: the wire answers the row itself, never a list of one.
  expect(((await landed.json()) as { readonly slug?: string }).slug).toBe(draft.slug);
});
