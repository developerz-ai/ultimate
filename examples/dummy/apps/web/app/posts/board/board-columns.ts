/**
 * The board's columns, from the org's posts: one per `POST_STATUSES` entry, in that order, so the
 * page's no-script shell and the island draw the same board. Plus the one rule a drop is held to:
 * `movePostStatus` moves between `draft` and `scheduled` only — publishing is `publishPost`'s, on
 * the post itself, because it stamps `publishedAt` in the same write.
 *
 * Imports one value, `@postly/domain`'s status list, so an island can load it.
 */

import { POST_STATUSES, type PostStatus } from '@postly/domain';

// Type aliases, not interfaces: an island prop must be JSON.
export type BoardPost = {
  readonly id: string;
  readonly title: string;
  readonly status: PostStatus;
};

export type BoardColumnLabels = Readonly<Record<PostStatus, string>>;

export type BoardLabels = {
  readonly board: string;
  readonly columns: BoardColumnLabels;
};

export type BoardPostColumn = {
  readonly id: PostStatus;
  readonly label: string;
  readonly items: readonly BoardPost[];
};

export const boardColumns = (
  posts: readonly BoardPost[],
  labels: BoardColumnLabels,
): BoardPostColumn[] =>
  POST_STATUSES.map((status) => ({
    id: status,
    label: labels[status],
    items: posts.filter((post) => post.status === status),
  }));

/** The two states `movePostStatus` may name. */
export type Schedulable = Exclude<PostStatus, 'published'>;

export const isSchedulable = (status: string): status is Schedulable =>
  status === 'draft' || status === 'scheduled';

/** A card may cross columns only between the two schedulable states. */
export const canMovePost = (post: BoardPost, to: string): boolean =>
  isSchedulable(post.status) && isSchedulable(to);
