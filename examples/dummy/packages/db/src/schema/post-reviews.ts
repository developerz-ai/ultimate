/**
 * The latest editorial review of a post — what `reviewDraft` decided, kept. One row per post:
 * `(orgId, postId)` IS the key, so the agent's `recordReview` tool is an upsert, and a background run the
 * queue replays from the top writes the same row again instead of a second one. That is what makes
 * the tool safe to hand an `agentJob` (`apps/web/app/posts/actions.ts`).
 */

import { entity, enumerated, text, timestamp, uuid } from '@ultimat3/entity';
import { members } from './members';
import { orgs } from './orgs';
import { posts } from './posts';

/** What `reviewDraft` answers — its output schema reads this list, so the two cannot drift. */
export const POST_REVIEW_VERDICTS = ['ready', 'revise'] as const;
export type PostReviewVerdict = (typeof POST_REVIEW_VERDICTS)[number];

export const REVIEW_NOTES_MAX = 600;

export const postReviews = entity('post_reviews', {
  columns: {
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    verdict: enumerated(POST_REVIEW_VERDICTS),
    notes: text({ max: REVIEW_NOTES_MAX }),
    /** The member the review was made for — the asker, never the model. */
    reviewedBy: uuid().references(() => members.id, { onDelete: 'cascade' }),
    reviewedAt: timestamp().defaultNow().onUpdateNow(),
  },
  // The tenant first: an UPDATING upsert must judge its collision against a key that names the org,
  // or a row another org stored would match and be overwritten (`X_TENANCY_UNSCOPED`).
  primaryKey: ['orgId', 'postId'],
  indexes: [{ on: ['orgId', 'reviewedAt'] }],
});

export type PostReview = typeof postReviews.$row;
