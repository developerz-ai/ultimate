/**
 * Every SQL statement the posts feature runs. No business rules here — the service decides what
 * to do, this file decides how to ask Postgres. The transaction is ambient (ALS), so an enqueue
 * in the same request lands in the same transaction as the write.
 *
 * `authorName` is `preload('author')`, never a join: `posts.authorId` already declares the foreign
 * key and a relation IS that key read the other way (`packages/entity/src/relations.ts`), so a page
 * of 50 posts costs one extra `where id in (…)` and never one statement per row. The related row
 * arrives as `unknown` — the other side is parsed by `PostAuthor`, never asserted into shape here.
 *
 * KNOWN GAP, and the only one left on this file: the public blog resolves a post by slug alone —
 * `/blog/{slug}` carries no tenant, which is why `post_slug_unique` is global — so
 * `publishedBySlug`, `publishedSlugs` and `publishedPage` read `posts` with no org predicate, and
 * @ultimat3/entity refuses that with `X_TENANCY_UNSCOPED` (`packages/entity/src/tenancy.ts`). A
 * tenant-columned entity has no cross-tenant escape hatch, deliberately; every other function
 * here now runs.
 */

import { type Comment, db, type Post } from '@postly/db';
import {
  type MemberId,
  type OrgId,
  type PostId,
  memberId as toMemberId,
  orgId as toOrgId,
} from '@postly/domain';
import { type CommentView, PostAuthor, type PostSummary, type PostView } from './entity';

/** The post page's aggregate: one row, its comments attached. Shared by the query and the route. */
export type PostWithComments = PostView & { readonly comments: readonly CommentView[] };

/** One prerenderable blog URL. `updatedAt` is what makes the sitemap's lastmod honest. */
export type PublishedSlug = { readonly slug: string; readonly updatedAt: Date };

/** The feed's activity badge: one synthetic row per org, `orgId` doubling as its tail key. */
export type ActivitySummary = { readonly orgId: OrgId; readonly publishedCount: number };

/** What `preload('author')` attaches to a page: the related row, under the relation's name. */
type WithAuthor = { readonly author: unknown };

/**
 * The feed's projection: every view column except `body`, because 50 bodies is not a feed.
 * `authorId` earns its place twice — the view carries it, and it is the key the preload reads.
 */
const SUMMARY_COLUMNS = {
  id: true,
  orgId: true,
  slug: true,
  title: true,
  excerpt: true,
  coverUrl: true,
  status: true,
  likeCount: true,
  publishedAt: true,
  authorId: true,
  // The key `liveFeed` orders by. A live query's rows must carry it — see `PostSummary` — and a
  // projection that drops it makes every change to the feed a full re-read.
  createdAt: true,
} as const;

/** The comment columns the view carries: `orgId` scopes the read, it is not wire data. */
const COMMENT_COLUMNS = {
  id: true,
  postId: true,
  authorId: true,
  body: true,
  createdAt: true,
} as const;

/** The post page's comment bound. A page, not a table — the aggregate has to stay one round trip. */
const COMMENT_PAGE = 100;

/**
 * The name off a preloaded `author`. A related row is `unknown` by construction, so it is parsed
 * rather than cast — and a post whose author cannot be read inside the post's own org fails here,
 * loudly, instead of rendering a card with an empty byline.
 */
const authorName = (author: unknown): string => PostAuthor.parse(author, 'author').name;

/** The wire shape, spelled field by field: a column dropped from `posts` fails to compile here. */
const postView = (row: Post, name: string): PostView => ({
  id: row.id,
  orgId: row.orgId,
  slug: row.slug,
  title: row.title,
  excerpt: row.excerpt,
  body: row.body,
  coverUrl: row.coverUrl,
  status: row.status,
  likeCount: row.likeCount,
  publishedAt: row.publishedAt,
  authorId: row.authorId,
  authorName: name,
});

/** A read's row: the author came with the page, in the statement the preload already sent. */
const readView = (row: Post & WithAuthor): PostView => postView(row, authorName(row.author));

/**
 * A write's row: a write answers with the row it stored and nothing else, so the name is one read
 * behind it — scoped to the row's own org, which is the scope the preload carries on a read.
 */
const writeView = async (row: Post): Promise<PostView> =>
  postView(
    row,
    authorName(
      await db.members.where({ orgId: row.orgId, id: row.authorId }).select({ name: true }).one(),
    ),
  );

/** The feed row: the same view, minus the body the projection never asked for. */
const summaryView = (row: Pick<Post, keyof typeof SUMMARY_COLUMNS> & WithAuthor): PostSummary => ({
  id: row.id,
  orgId: row.orgId,
  slug: row.slug,
  title: row.title,
  excerpt: row.excerpt,
  coverUrl: row.coverUrl,
  status: row.status,
  likeCount: row.likeCount,
  publishedAt: row.publishedAt,
  authorId: row.authorId,
  createdAt: row.createdAt,
  authorName: authorName(row.author),
});

/** Spelled out like the post's, so a write's row answers with exactly what a read's does. */
const commentView = (row: Pick<Comment, keyof typeof COMMENT_COLUMNS>): CommentView => ({
  id: row.id,
  postId: row.postId,
  authorId: row.authorId,
  body: row.body,
  createdAt: row.createdAt,
});

export const byId = async (orgId: OrgId, id: PostId): Promise<PostView | null> => {
  const row = await db.posts.where({ orgId, id }).preload('author').one();
  return row === null ? null : readView(row);
};

export const bySlug = async (orgId: OrgId, slug: string): Promise<PostView | null> => {
  const row = await db.posts.where({ orgId, slug }).preload('author').one();
  return row === null ? null : readView(row);
};

/**
 * Authorship only: the policy needs two columns, not a whole row. The org is a parameter and the
 * caller decides it — `service.ts` passes the ACTING member's, because this read happens before
 * the guard and a read into another tenant raises instead of denying.
 */
export const authorshipOf = async (
  orgId: OrgId,
  id: PostId,
): Promise<{ orgId: OrgId; authorId: MemberId } | null> => {
  const row = await db.posts.where({ orgId, id }).select({ orgId: true, authorId: true }).one();
  return row === null ? null : { orgId: toOrgId(row.orgId), authorId: toMemberId(row.authorId) };
};

export const insertDraft = async (row: {
  orgId: OrgId;
  authorId: MemberId;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
}): Promise<PostView> => writeView(await db.posts.insert(row));

export const markPublished = async (orgId: OrgId, id: PostId, at: Date): Promise<PostView> =>
  writeView(await db.posts.update(id, { status: 'published', publishedAt: at }, { orgId }));

/**
 * Insert-or-ignore: the composite primary key on `likes` makes a replayed offline like a no-op at
 * the storage layer, so the counter cannot drift on reconnect. `upsertAll` resolves with the rows
 * it actually wrote, so an empty result IS "that like was already there" — and `onMatch: 'nothing'`
 * needs no tenant column in the conflict target, because it writes nothing to a row it does not own.
 */
export const insertLike = async (
  orgId: OrgId,
  postId: PostId,
  memberId: MemberId,
): Promise<{ inserted: boolean }> => {
  const written = await db.likes.upsertAll([{ orgId, postId, memberId }], {
    onConflict: ['postId', 'memberId'],
    onMatch: 'nothing',
  });
  return { inserted: written.length > 0 };
};

/** `deleteWhere`, because `likes` has a composite key and one id cannot name the row. */
export const deleteLike = async (
  orgId: OrgId,
  postId: PostId,
  memberId: MemberId,
): Promise<{ deleted: boolean }> => ({
  deleted: (await db.likes.deleteWhere({ orgId, postId, memberId })) > 0,
});

/** The count is the statement, never a value the caller passed in: a like is counted, not tracked. */
export const recountLikes = async (orgId: OrgId, postId: PostId): Promise<PostView> => {
  const likeCount = await db.likes.where({ orgId, postId }).count();
  return writeView(await db.posts.update(postId, { likeCount }, { orgId }));
};

export const publishedSince = async (orgId: OrgId, since: Date): Promise<PostSummary[]> =>
  (
    await db.posts
      .where({ orgId, status: 'published' })
      .andWhere('publishedAt', 'gte', since)
      .orderBy('publishedAt', 'desc')
      .limit(20)
      .select(SUMMARY_COLUMNS)
      .preload('author')
      .all()
  ).map(summaryView);

/**
 * One row, one statement, for the feed's streamed activity badge — `feedActivity` in `live.ts`
 * wraps this so the count arrives independently of the feed itself, which reads over the socket.
 */
export const activitySummary = async (orgId: OrgId): Promise<ActivitySummary[]> => {
  const publishedCount = await db.posts.where({ orgId, status: 'published' }).count();
  return [{ orgId, publishedCount }];
};

export const insertComment = async (row: {
  orgId: OrgId;
  postId: PostId;
  authorId: MemberId;
  body: string;
}): Promise<CommentView> => commentView(await db.comments.insert(row));

/**
 * The org feed's page. Ordered and bounded here as well as in the query — `live: true` needs it.
 *
 * `createdAt` alone is a partial order, but the tail key is not written out here: @ultimat3/entity
 * appends the primary key to every plan (`plan.ts`, `totalOrder`) precisely so a cursor page has a
 * total order. Repeating it would be a second declaration of the same rule, and an ascending `id`
 * spelled `desc` by hand would silently disagree with the page the driver actually returns. The
 * live query in `live.ts` does write it out, because `from()` builds its shape from that call.
 */
export const feedPage = async (orgId: OrgId, limit: number): Promise<PostSummary[]> =>
  (
    await db.posts
      .where({ orgId })
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .select(SUMMARY_COLUMNS)
      .preload('author')
      .all()
  ).map(summaryView);

/**
 * The post page's aggregate. Two statements plus the preload, and the comments are their own read
 * rather than `preload('comments')`: a preload attaches every related row in the relation's own
 * order, and this page is ordered and bounded — which is exactly what the live query declares.
 */
export const withComments = async (orgId: OrgId, id: PostId): Promise<PostWithComments[]> => {
  const post = await byId(orgId, id);
  if (post === null) return [];
  const comments = await db.comments
    .where({ orgId, postId: id })
    .orderBy('createdAt')
    .limit(COMMENT_PAGE)
    .select(COMMENT_COLUMNS)
    .all();
  return [{ ...post, comments: comments.map(commentView) }];
};

/**
 * The public blog index's page. The same summary the org feed renders — a card needs a title, an
 * excerpt and a byline, not a slug — so `site/` and `app/` map one row shape through one
 * `toCardPost`, which is the property that makes a second mapping unnecessary.
 */
export const publishedPage = async (limit: number): Promise<PostSummary[]> =>
  (
    await db.posts
      .where({ status: 'published' })
      .orderBy('publishedAt', 'desc')
      .limit(limit)
      .select(SUMMARY_COLUMNS)
      .preload('author')
      .all()
  ).map(summaryView);

/** One published post, by slug, anywhere — the public blog has no tenant in the URL. */
export const publishedBySlug = async (slug: string): Promise<PostView[]> =>
  (await db.posts.where({ slug, status: 'published' }).limit(1).preload('author').all()).map(
    readView,
  );

/** The same row, tenant-scoped: the signed-in read of a post the member's org published. */
export const publishedBySlugInOrg = async (orgId: OrgId, slug: string): Promise<PostView[]> =>
  (await db.posts.where({ orgId, slug, status: 'published' }).limit(1).preload('author').all()).map(
    readView,
  );

/** Feeds the `prerender()` enumeration of the public blog route. */
export const publishedSlugs = (): Promise<readonly PublishedSlug[]> =>
  db.posts
    .where({ status: 'published' })
    .orderBy('publishedAt', 'desc')
    .limit(1000)
    .select({ slug: true, updatedAt: true })
    .all();
