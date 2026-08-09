/**
 * Every SQL statement the posts feature runs. No business rules here — the service decides what
 * to do, this file decides how to ask Postgres. The transaction is ambient (ALS), so an enqueue
 * in the same request lands in the same transaction as the write.
 */

import { db } from '@postly/db';
import type { MemberId, OrgId, PostId } from '@postly/domain';
import type { CommentView, PostSummary, PostView } from './entity';

/** The post page's aggregate: one row, its comments attached. Shared by the query and the route. */
export type PostWithComments = PostView & { readonly comments: readonly CommentView[] };

/** One prerenderable blog URL. `updatedAt` is what makes the sitemap's lastmod honest. */
export type PublishedSlug = { readonly slug: string; readonly updatedAt: Date };

const withAuthor = { authorName: db.members.name } as const;

export const byId = (orgId: OrgId, id: PostId): Promise<PostView | null> =>
  db.posts.where({ orgId, id }).join(db.members).select(withAuthor).one();

export const bySlug = (orgId: OrgId, slug: string): Promise<PostView | null> =>
  db.posts.where({ orgId, slug }).join(db.members).select(withAuthor).one();

/** Authorship only: the policy needs two columns, not a whole row. */
export const authorshipOf = (id: PostId): Promise<{ orgId: OrgId; authorId: MemberId } | null> =>
  db.posts.where({ id }).select({ orgId: true, authorId: true }).one();

export const insertDraft = (row: {
  orgId: OrgId;
  authorId: MemberId;
  slug: string;
  title: string;
  excerpt: string;
  body: string;
}): Promise<PostView> => db.posts.insert(row).returning();

export const markPublished = (orgId: OrgId, id: PostId, at: Date): Promise<PostView> =>
  db.posts.where({ orgId, id }).update({ status: 'published', publishedAt: at }).returning();

/**
 * Insert-or-ignore: the composite primary key on `likes` makes a replayed offline like a no-op
 * at the storage layer, so the counter cannot drift on reconnect.
 */
export const insertLike = (
  orgId: OrgId,
  postId: PostId,
  memberId: MemberId,
): Promise<{ inserted: boolean }> =>
  db.likes.insert({ orgId, postId, memberId }).onConflictDoNothing().returningInserted();

export const deleteLike = (
  orgId: OrgId,
  postId: PostId,
  memberId: MemberId,
): Promise<{ deleted: boolean }> => db.likes.where({ orgId, postId, memberId }).delete();

export const recountLikes = (orgId: OrgId, postId: PostId): Promise<PostView> =>
  db.posts
    .where({ orgId, id: postId })
    .update({ likeCount: db.likes.where({ postId }).count() })
    .returning();

export const publishedSince = (orgId: OrgId, since: Date): Promise<PostSummary[]> =>
  db.posts
    .where({ orgId, status: 'published' })
    .andWhere('publishedAt', '>=', since)
    .orderBy('publishedAt', 'desc')
    .limit(20)
    .join(db.members)
    .select(withAuthor)
    .all();

export const insertComment = (row: {
  orgId: OrgId;
  postId: PostId;
  authorId: MemberId;
  body: string;
}): Promise<CommentView> => db.comments.insert(row).returning();

/**
 * The org feed's page. Ordered and bounded here as well as in the query — `live: true` needs it.
 *
 * `createdAt` alone is a partial order, but the tail key is not written out here: @ultimat3/entity
 * appends the primary key to every plan (`repo.ts`, `planFor`) precisely so a cursor page has a
 * total order. Repeating it would be a second declaration of the same rule, and an ascending `id`
 * spelled `desc` by hand would silently disagree with the page the driver actually returns. The
 * live query in `live.ts` does write it out, because `from()` builds its shape from that call.
 */
export const feedPage = (orgId: OrgId, limit: number): Promise<PostSummary[]> =>
  db.posts
    .where({ orgId })
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .join(db.members)
    .select(withAuthor)
    .all();

/** The post page in one round trip: the aggregate, not two queries the client has to join. */
export const withComments = (orgId: OrgId, id: PostId): Promise<PostWithComments[]> =>
  db.posts
    .where({ orgId, id })
    .join(db.members)
    .select(withAuthor)
    .with({ comments: db.comments.where({ postId: id }).orderBy('createdAt').limit(100) })
    .all();

/** One published post, by slug, anywhere — the public blog has no tenant in the URL. */
export const publishedBySlug = (slug: string): Promise<PostView[]> =>
  db.posts.where({ slug, status: 'published' }).join(db.members).select(withAuthor).limit(1).all();

/** The same row, tenant-scoped: the signed-in read of a post the member's org published. */
export const publishedBySlugInOrg = (orgId: OrgId, slug: string): Promise<PostView[]> =>
  db.posts
    .where({ orgId, slug, status: 'published' })
    .join(db.members)
    .select(withAuthor)
    .limit(1)
    .all();

/** Feeds the `prerender()` enumeration of the public blog route. */
export const publishedSlugs = (): Promise<PublishedSlug[]> =>
  db.posts
    .where({ status: 'published' })
    .select({ slug: true, updatedAt: true })
    .orderBy('publishedAt', 'desc')
    .limit(1000)
    .all();
