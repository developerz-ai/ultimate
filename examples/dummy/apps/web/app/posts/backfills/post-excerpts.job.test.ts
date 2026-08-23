/**
 * `postExcerpts` sweeps rows nobody asked it to, so the two facts worth failing on are its durable
 * identity — one live run per name, retried under the same key — and that the projection it
 * applies is IDEMPOTENT, because a page replays whole when an attempt is cancelled between its
 * last row and its checkpoint.
 *
 * A backfill IS a job, so this is a `jobTest` in a `.job.test.ts` file: the gate types a test by
 * its filename, and `<name>.test.ts` would have put it in the `unit` step for ever.
 */

import type { Post } from '@postly/db';
import { postId as toPostId } from '@postly/domain';
import { createMemoryDriver, resetJobDriver, setJobDriver } from '@ultimat3/jobs';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { postExcerpts, withExcerpt } from './post-excerpts';

// The job driver is process-global, so it is installed and released around this file rather than
// left behind for whichever test file runs next.
beforeAll(() => {
  setJobDriver(createMemoryDriver());
});
afterAll(resetJobDriver);

/** The durable name this sweep runs under — the queue row, the step trace and `x_backfills`. */
const expectedKey = 'post-excerpts';

const row = (over: Partial<Post> = {}): Post =>
  ({
    id: toPostId('00000000-0000-4000-8000-000000000001'),
    orgId: '00000000-0000-4000-8000-000000000002',
    authorId: '00000000-0000-4000-8000-000000000003',
    slug: 'a-post',
    title: 'A post',
    excerpt: '',
    body: 'The body this excerpt is derived from.',
    coverUrl: null,
    status: 'draft',
    likeCount: 0,
    publishedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }) as Post;

jobTest('postExcerpts is a job, because backfill() is a factory over job()', () => {
  expect(postExcerpts.kind).toBe('job');
  expect(postExcerpts.retry.attempts).toBeGreaterThan(1);
});

jobTest('postExcerpts runs under one durable key, forced or not', () => {
  expect(postExcerpts.idempotencyKeyFor({})).toBe(expectedKey);
  expect(postExcerpts.idempotencyKeyFor({ force: true })).toBe(expectedKey);
});

jobTest('postExcerpts projects itself into the manifest', () => {
  const described = postExcerpts.describe();
  expect(described.name).toBe(expectedKey);
  expect(described.retry.attempts).toBeGreaterThan(0);
});

jobTest('postExcerpts actually fills the excerpt it was declared for', () => {
  // The declaration alone cannot fail this: a handler that returned without writing would still
  // enqueue, still checkpoint and still report the page as swept.
  expect(withExcerpt(row()).excerpt).toBe('The body this excerpt is derived from.');
});

jobTest('postExcerpts replays a page idempotently', () => {
  // At-least-once is the contract, not an edge case: an attempt cancelled between the last row
  // and its checkpoint hands this page to the next attempt. Twice through must equal once through.
  const once = withExcerpt(row());
  expect(withExcerpt(once)).toEqual(once);
});

jobTest('postExcerpts never rewrites an excerpt somebody already wrote', () => {
  const written = row({ excerpt: 'Hand-written.' });
  expect(withExcerpt(written)).toEqual(written);
});

jobTest('postExcerpts enqueues once, and dedupes the second kick', async () => {
  // One live run per name: a second enqueue while the pass is going is the same pass, which is
  // what makes "kick it again" safe rather than a second writer on one table.
  const first = await postExcerpts.enqueue({});
  expect(first.deduped).toBe(false);
  const again = await postExcerpts.enqueue({});
  expect(again.deduped).toBe(true);
});
