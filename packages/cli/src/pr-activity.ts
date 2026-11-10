// The rest of a pull request's conversation, beside its inline threads: every review with its
// verdict and body, and every ISSUE comment. A bot that said "I did not review this" says it in one
// of these two places and never in a thread, so `x pr review` asks for both in the same round trip.

import { t } from '@ultimat3/schema';

/** The newest reviews, and the newest issue comments, one page each. */
export const ACTIVITY_PAGE = 50;

/**
 * The fragment `REVIEW_QUERY` (`pr-threads.ts`) splices into its `pullRequest` selection. `last`,
 * not `first`: a long pull request's oldest conversation is the least likely to still matter, and
 * a bot's "review limit" notice is by construction among the newest.
 */
export const ACTIVITY_FIELDS =
  `reviews(last:${ACTIVITY_PAGE}){totalCount nodes{id state body submittedAt url ` +
  'author{login __typename} commit{oid}}} ' +
  `comments(last:${ACTIVITY_PAGE}){totalCount nodes{id body createdAt updatedAt url ` +
  'author{login __typename}}}';

const ACTOR = t.nullable(t.object({ login: t.string, __typename: t.string }));

/** The two connections, as `REVIEW_RESPONSE` declares them inside `pullRequest`. */
export const ACTIVITY_SCHEMA = {
  reviews: t.object({
    totalCount: t.number,
    nodes: t.array(
      t.object({
        id: t.string,
        state: t.string,
        body: t.string,
        submittedAt: t.nullable(t.string),
        url: t.string,
        author: ACTOR,
        commit: t.nullable(t.object({ oid: t.string })),
      }),
    ),
  }),
  comments: t.object({
    totalCount: t.number,
    nodes: t.array(
      t.object({
        id: t.string,
        body: t.string,
        createdAt: t.string,
        updatedAt: t.string,
        url: t.string,
        author: ACTOR,
      }),
    ),
  }),
} as const;

/** One submitted review: a verdict (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, …) and its body. */
export interface PrReviewEntry {
  readonly id: string;
  readonly state: string;
  readonly author: string;
  readonly isBot: boolean;
  readonly submittedAt: string | null;
  readonly commit: string | null;
  /** Submitted against a commit that is no longer the head — the same rule as `PrReview.stale`. */
  readonly stale: boolean;
  readonly url: string;
  readonly body: string;
}

/** One comment on the pull request itself, not anchored to a line. */
export interface PrIssueComment {
  readonly id: string;
  readonly author: string;
  readonly isBot: boolean;
  readonly createdAt: string;
  /** A bot edits its summary comment in place, so this — not `createdAt` — dates what it says. */
  readonly updatedAt: string;
  readonly url: string;
  readonly body: string;
}

export interface PrActivity {
  readonly reviews: readonly PrReviewEntry[];
  readonly comments: readonly PrIssueComment[];
  /** More reviews exist than one page holds. */
  readonly reviewsTruncated: boolean;
  /** More issue comments exist than one page holds. */
  readonly commentsTruncated: boolean;
}

type Actor = { readonly login: string; readonly __typename: string } | null;

/** GitHub answers `null` for a deleted account; the row is kept under the name GitHub shows. */
const loginOf = (author: Actor): string => author?.login ?? 'ghost';

/** GraphQL types an app account `Bot`; a REST-shaped login ends in `[bot]`. Either is a bot. */
const isBot = (author: Actor): boolean =>
  author !== null && (author.__typename === 'Bot' || author.login.endsWith('[bot]'));

interface ActivityInput {
  readonly reviews: {
    readonly totalCount: number;
    readonly nodes: readonly {
      readonly id: string;
      readonly state: string;
      readonly body: string;
      readonly submittedAt: string | null;
      readonly url: string;
      readonly author: Actor;
      readonly commit: { readonly oid: string } | null;
    }[];
  };
  readonly comments: {
    readonly totalCount: number;
    readonly nodes: readonly {
      readonly id: string;
      readonly body: string;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly url: string;
      readonly author: Actor;
    }[];
  };
}

/** The parsed connections as rows, oldest first — the order the conversation happened in. */
export function activityOf(pull: ActivityInput, headSha: string): PrActivity {
  return {
    reviews: pull.reviews.nodes.map((review) => ({
      id: review.id,
      state: review.state,
      author: loginOf(review.author),
      isBot: isBot(review.author),
      submittedAt: review.submittedAt,
      commit: review.commit?.oid ?? null,
      stale: review.commit?.oid !== headSha,
      url: review.url,
      body: review.body,
    })),
    comments: pull.comments.nodes.map((comment) => ({
      id: comment.id,
      author: loginOf(comment.author),
      isBot: isBot(comment.author),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: comment.url,
      body: comment.body,
    })),
    reviewsTruncated: pull.reviews.totalCount > pull.reviews.nodes.length,
    commentsTruncated: pull.comments.totalCount > pull.comments.nodes.length,
  };
}
