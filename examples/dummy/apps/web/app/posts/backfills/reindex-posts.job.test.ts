/**
 * `reindexPosts` is the post search index rebuilt from the table. What is worth failing on: its
 * durable identity (one live pass per name), and the document each post becomes — the title and
 * nothing else of the row, under the post's own org, versioned by `updatedAt` so an index keeps
 * the newer of two writes.
 */

import { type Post, posts } from '@postly/db';
import { postId as toPostId } from '@postly/domain';
import { searchDocumentOf } from '@ultimat3/entity';
import { memoryJobDriver } from '@ultimat3/jobs';
import { installJobDriver } from '@ultimat3/jobs/adapter';
import { afterAll, beforeAll, expect, jobTest } from '@ultimat3/testing';
import { reindexPosts } from './reindex-posts';

let release = (): void => {};
beforeAll(() => {
  release = installJobDriver(memoryJobDriver());
});
afterAll(() => release());

const row = (over: Partial<Post> = {}): Post =>
  ({
    id: toPostId('00000000-0000-4000-8000-000000000001'),
    orgId: '00000000-0000-4000-8000-000000000002',
    authorId: '00000000-0000-4000-8000-000000000003',
    slug: 'a-post',
    title: 'Shipping on Fridays',
    excerpt: 'never',
    body: 'A body the index never sees.',
    coverUrl: null,
    status: 'published',
    likeCount: 0,
    publishedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(5_000),
    ...over,
  }) as Post;

jobTest('reindexPosts is a backfill job under one durable key, forced or not', () => {
  expect(reindexPosts.kind).toBe('job');
  expect(reindexPosts.idempotencyKeyFor({})).toBe('reindex-posts');
  expect(reindexPosts.idempotencyKeyFor({ force: true })).toBe('reindex-posts');
});

jobTest('a post is indexed as its title alone, under its org, versioned by updatedAt', () => {
  const post = row();
  const document = searchDocumentOf(posts, post);
  expect(document.fields).toEqual({ title: 'Shipping on Fridays' });
  expect(document.tenant).toBe(post.orgId);
  expect(document.version).toBe(5_000);
  // A later edit carries a greater version: the index keeps it over the pass's older read.
  expect(searchDocumentOf(posts, row({ updatedAt: new Date(9_000) })).version).toBeGreaterThan(
    document.version,
  );
});
