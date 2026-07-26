/**
 * Every SQL statement the posts feature runs. No business rules here — the service decides what
 * to do, this file decides how to ask Postgres. The transaction is ambient (ALS), so an enqueue
 * in the same request lands in the same transaction as the write.
 */

import { db } from '@postly/db';
import type { MemberId, OrgId, PostId } from '@postly/domain';
import type { CommentView, PostSummary, PostView } from './entity';

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

/** Feeds the `prerender()` enumeration of the public blog route. */
export const publishedSlugs = (): Promise<{ slug: string; updatedAt: Date }[]> =>
  db.posts.where({ status: 'published' }).select({ slug: true, updatedAt: true }).all();
