/**
 * unit — the posts feature's statements against the in-memory driver, which shares its plan
 * builder, tenancy guard, projection and preload with the Postgres one (`packages/entity/CLAUDE.md`).
 * Every assertion below is one the builder API this file used to be written against could not
 * answer: a preloaded author name, an idempotent like, a composite-key delete, a feed row with no
 * body, a read that stops at the org boundary.
 */

import { expect, test } from 'bun:test';
import { db } from '@postly/db';
import { type MemberId, memberId, type OrgId, orgId, type PostId, postId } from '@postly/domain';
import * as repo from './repo';

/** Distinct per call, so one test's rows never answer another's read — the store is process-wide. */
let issued = 0;
const nextId = (): string => {
  issued += 1;
  return `00000000-0000-4000-8000-${String(issued).padStart(12, '0')}`;
};

const AUTHOR = 'Ada Lovelace';

/** An org with one member in it. No `orgs` row: nothing here reads one, and a test seeds facts. */
const anOrg = async (): Promise<{ orgId: OrgId; authorId: MemberId }> => {
  const org = orgId(nextId());
  const author = await db.members.insert({
    orgId: org,
    userId: nextId(),
    email: 'ada@postly.dev',
    name: AUTHOR,
  });
  return { orgId: org, authorId: memberId(author.id) };
};

/** A stored post, written straight through `db` so the test owns `createdAt` and `publishedAt`. */
const aPost = async (
  at: { orgId: OrgId; authorId: MemberId },
  values: { slug: string; createdAt?: Date; publishedAt?: Date },
): Promise<PostId> => {
  const row = await db.posts.insert({
    orgId: at.orgId,
    authorId: at.authorId,
    slug: values.slug,
    title: `Post ${values.slug}`,
    excerpt: 'an excerpt',
    body: 'a body',
    ...(values.createdAt === undefined ? {} : { createdAt: values.createdAt }),
    ...(values.publishedAt === undefined
      ? {}
      : { status: 'published' as const, publishedAt: values.publishedAt }),
  });
  return postId(row.id);
};

test('insertDraft answers with the view, author name included', async () => {
  const at = await anOrg();

  const draft = await repo.insertDraft({
    ...at,
    slug: 'raii',
    title: 'RAII',
    excerpt: 'e',
    body: 'b',
  });

  expect(draft.authorName).toBe(AUTHOR);
  expect(draft.status).toBe('draft');
  expect(draft.likeCount).toBe(0);
});

test('byId preloads the author, and stops at the org boundary', async () => {
  const at = await anOrg();
  const other = await anOrg();
  const id = await aPost(at, { slug: 'preload' });

  expect((await repo.byId(at.orgId, id))?.authorName).toBe(AUTHOR);
  expect(await repo.bySlug(at.orgId, 'preload')).not.toBeNull();
  expect(await repo.byId(other.orgId, id)).toBeNull();
});

test('the feed is the summary projection — no body, newest first', async () => {
  const at = await anOrg();
  await aPost(at, { slug: 'older', createdAt: new Date('2026-01-01T00:00:00Z') });
  await aPost(at, { slug: 'newer', createdAt: new Date('2026-02-01T00:00:00Z') });

  const page = await repo.feedPage(at.orgId, 10);

  expect(page.map((row) => row.slug)).toEqual(['newer', 'older']);
  expect(page.every((row) => row.authorName === AUTHOR)).toBe(true);
  expect(page.every((row) => !Object.hasOwn(row, 'body'))).toBe(true);
});

test('publishedSince takes the boundary instant and leaves the one before it', async () => {
  const at = await anOrg();
  await aPost(at, { slug: 'before', publishedAt: new Date('2026-01-01T00:00:00Z') });
  await aPost(at, { slug: 'on', publishedAt: new Date('2026-02-01T00:00:00Z') });
  await aPost(at, { slug: 'draft-one' });

  const since = await repo.publishedSince(at.orgId, new Date('2026-02-01T00:00:00Z'));

  expect(since.map((row) => row.slug)).toEqual(['on']);
});

test('markPublished stamps the instant and keeps the view whole', async () => {
  const at = await anOrg();
  const id = await aPost(at, { slug: 'publishable' });
  const at9 = new Date('2026-03-01T09:00:00Z');

  const published = await repo.markPublished(at.orgId, id, at9);

  expect(published.status).toBe('published');
  expect(published.publishedAt).toEqual(at9);
  expect(published.authorName).toBe(AUTHOR);
});

test('a replayed like writes nothing, and the recount stays at one', async () => {
  const at = await anOrg();
  const id = await aPost(at, { slug: 'likeable' });

  expect(await repo.insertLike(at.orgId, id, at.authorId)).toEqual({ inserted: true });
  expect(await repo.insertLike(at.orgId, id, at.authorId)).toEqual({ inserted: false });

  expect((await repo.recountLikes(at.orgId, id)).likeCount).toBe(1);
});

test('deleteLike removes the composite-key row and reports whether it was there', async () => {
  const at = await anOrg();
  const id = await aPost(at, { slug: 'unlikeable' });
  await repo.insertLike(at.orgId, id, at.authorId);

  expect(await repo.deleteLike(at.orgId, id, at.authorId)).toEqual({ deleted: true });
  expect(await repo.deleteLike(at.orgId, id, at.authorId)).toEqual({ deleted: false });
  expect((await repo.recountLikes(at.orgId, id)).likeCount).toBe(0);
});

test('withComments is the aggregate, ordered, and empty for a post that is not there', async () => {
  const at = await anOrg();
  const id = await aPost(at, { slug: 'discussed' });
  // Written newest first and stamped oldest last, so the page's order has to come from
  // `createdAt` — the clock is frozen, and the key the driver falls back to is insertion order.
  for (const [body, day] of [
    ['later', '02'],
    ['earlier', '01'],
  ]) {
    await repo.insertComment({
      orgId: at.orgId,
      postId: id,
      authorId: at.authorId,
      body: String(body),
    });
    await db.comments.updateWhere(
      { orgId: at.orgId, postId: id, body: String(body) },
      { createdAt: new Date(`2026-04-${String(day)}T00:00:00Z`) },
    );
  }

  const [aggregate] = await repo.withComments(at.orgId, id);

  expect(aggregate?.authorName).toBe(AUTHOR);
  expect(aggregate?.comments.map((comment) => comment.body)).toEqual(['earlier', 'later']);
  expect(await repo.withComments(at.orgId, postId(nextId()))).toEqual([]);
});

test('authorshipOf answers two columns, and only inside the org it was asked for', async () => {
  const at = await anOrg();
  const other = await anOrg();
  const id = await aPost(at, { slug: 'owned' });

  expect(await repo.authorshipOf(at.orgId, id)).toEqual({
    orgId: at.orgId,
    authorId: at.authorId,
  });
  expect(await repo.authorshipOf(other.orgId, id)).toBeNull();
});
