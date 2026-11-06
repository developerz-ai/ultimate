/**
 * A `keepDraftReview` run in flight — the signed handle `reviewDraft`'s `onCheckpoint` hands over
 * between turns, kept so an attempt the queue retries after a dead worker resumes with
 * `.continue()` instead of re-buying every turn and re-running every tool. One row per post, keyed
 * as the review it leads to: `keepDraftReview` opens it, the hook writes into it, keeping the
 * review deletes it. Its own table because a review row exists only once there is a verdict.
 */

import { entity, json, t, text, timestamp, uuid } from '@ultimat3/entity';
import { orgs } from './orgs';
import { posts } from './posts';

/** A keyed fingerprint (`h1:<key id>:<mac>`) — 3 + 8 + 32 characters and two colons. */
export const REVIEW_DRAFT_MARK_MAX = 64;

export const postReviewRuns = entity('post_review_runs', {
  columns: {
    postId: uuid().references(() => posts.id, { onDelete: 'cascade' }),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    /**
     * The draft the run was opened for, fingerprinted: the transcript holds the post as it was SENT,
     * so a run whose draft has since changed starts over rather than reviewing the old words.
     */
    draft: text({ max: REVIEW_DRAFT_MARK_MAX }),
    /**
     * The latest checkpoint, `null` until the first. OPAQUE: stored as JSON and handed back to
     * `.continue()`, whose screen checks the signature, the agent, the model and the tenant first.
     */
    checkpoint: json(t.json()).nullable(),
    openedAt: timestamp().defaultNow(),
  },
  // The tenant first, as `post_reviews`' key is: an updating upsert judges its collision on a key
  // that names the org (`X_TENANCY_UNSCOPED`).
  primaryKey: ['orgId', 'postId'],
});

export type PostReviewRun = typeof postReviewRuns.$row;
