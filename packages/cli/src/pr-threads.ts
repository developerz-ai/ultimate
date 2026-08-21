// The GraphQL a review lives behind, and the rows it becomes. `gh pr view --comments` shows ISSUE
// comments; the findings a reviewer anchored to a line are `reviewThreads`, and the thread id that
// resolves one exists in no REST response and in no web URL — this file is where that query stops
// being folklore.

import { t } from '@ultimat3/schema';
import type { GhHost } from './gh';
import { GhResponseInvalidError, ghGraphql } from './gh';
import type { GhRepo } from './gh-target';

/**
 * How many threads one page holds. The query is built from it, so the report and the request can
 * never disagree about what "the first page" was.
 */
export const THREAD_PAGE = 100;

/** And how many comments of each. A long argument still shows the finding that opened it. */
export const COMMENT_PAGE = 10;

/**
 * One document, because the two hazards are only visible together: a `reviewDecision` survives
 * later pushes, so `CHANGES_REQUESTED` may predate the commits that addressed it, and the only
 * thing that settles it is the head oid — asking for the threads and then asking for the head is
 * two answers about two moments.
 */
export const REVIEW_QUERY =
  'query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){' +
  'pullRequest(number:$n){number url headRefOid reviewDecision ' +
  'commits(last:1){nodes{commit{oid committedDate}}} ' +
  'latestOpinionatedReviews(first:20){nodes{state submittedAt author{login} commit{oid}}} ' +
  `reviewThreads(first:${THREAD_PAGE}){pageInfo{hasNextPage} nodes{id isResolved isOutdated ` +
  `path line originalLine comments(first:${COMMENT_PAGE}){totalCount ` +
  'nodes{author{login} createdAt body}}}}}}}';

const AUTHOR = t.nullable(t.object({ login: t.string }));

const REVIEW_RESPONSE = t.object({
  data: t.object({
    repository: t.nullable(
      t.object({
        pullRequest: t.nullable(
          t.object({
            number: t.number,
            url: t.string,
            headRefOid: t.string,
            reviewDecision: t.nullable(t.string),
            commits: t.object({
              nodes: t.array(
                t.object({ commit: t.object({ oid: t.string, committedDate: t.string }) }),
              ),
            }),
            latestOpinionatedReviews: t.object({
              nodes: t.array(
                t.object({
                  state: t.string,
                  submittedAt: t.nullable(t.string),
                  author: AUTHOR,
                  commit: t.nullable(t.object({ oid: t.string })),
                }),
              ),
            }),
            reviewThreads: t.object({
              pageInfo: t.object({ hasNextPage: t.boolean }),
              nodes: t.array(
                t.object({
                  id: t.string,
                  isResolved: t.boolean,
                  isOutdated: t.boolean,
                  path: t.string,
                  line: t.nullable(t.number),
                  originalLine: t.nullable(t.number),
                  comments: t.object({
                    totalCount: t.number,
                    nodes: t.array(
                      t.object({ author: AUTHOR, createdAt: t.string, body: t.string }),
                    ),
                  }),
                }),
              ),
            }),
          }),
        ),
      }),
    ),
  }),
});

export interface PrComment {
  readonly author: string;
  readonly createdAt: string;
  readonly body: string;
}

export interface PrThread {
  readonly id: string;
  readonly path: string;
  /** The line the comment is anchored to NOW; `null` once the diff has moved under it. */
  readonly line: number | null;
  /** Where it was anchored when it was written — the only locator an outdated thread still has. */
  readonly originalLine: number | null;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly comments: readonly PrComment[];
  /** Every comment on the thread, against the ten this page carries. */
  readonly commentCount: number;
}

export interface PrReview {
  readonly state: string;
  readonly author: string;
  readonly submittedAt: string | null;
  readonly commit: string | null;
  /**
   * The review was submitted against a commit that is no longer the head. A verdict about the
   * COMMIT, not about the clock: two reviews seconds apart can straddle a push, and a timestamp
   * comparison would call one of them current.
   */
  readonly stale: boolean;
}

export interface PrReviewReport {
  readonly repo: string;
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly headCommittedAt: string | null;
  readonly reviewDecision: string | null;
  /** The review the decision came from, when one of the opinionated reviews states it. */
  readonly decidingReview: PrReview | null;
  readonly threads: readonly PrThread[];
  /** More threads exist than one page holds, so `threads` is the first page and not the set. */
  readonly truncated: boolean;
}

/** GitHub answers `null` for a deleted account. A row with no author still carries its finding. */
const loginOf = (author: { readonly login: string } | null): string => author?.login ?? 'ghost';

/**
 * The review a `reviewDecision` came from. GitHub derives the decision from every opinionated
 * review at once, so the one that STATES it is the one to date — falling back to the newest, which
 * is the only defensible guess when none of them spells the decision out.
 */
export function decidingReview(
  reviews: readonly PrReview[],
  decision: string | null,
): PrReview | null {
  const stating = reviews.filter((review) => review.state === decision);
  const pool = stating.length > 0 ? stating : reviews;
  return pool.reduce<PrReview | null>(
    (newest, review) =>
      newest === null || (review.submittedAt ?? '') > (newest.submittedAt ?? '') ? review : newest,
    null,
  );
}

/** Unresolved first, then by file and line: the order an agent works the list in. */
export function orderThreads(threads: readonly PrThread[]): readonly PrThread[] {
  return [...threads].sort((left, right) => {
    if (left.isResolved !== right.isResolved) return left.isResolved ? 1 : -1;
    if (left.path !== right.path) return left.path < right.path ? -1 : 1;
    return (left.line ?? left.originalLine ?? 0) - (right.line ?? right.originalLine ?? 0);
  });
}

/**
 * One round trip, one report. `repository` and `pullRequest` are both nullable in the schema
 * because GraphQL answers `null` for either — but gh exits non-zero on the `errors` block that
 * accompanies it, so reaching here with a `null` means GitHub answered a shape nobody has seen,
 * and `X_GH_RESPONSE_INVALID` is a better sentence for that than a `TypeError` two frames later.
 */
export async function fetchReviewReport(
  host: GhHost,
  repo: GhRepo,
  number: number,
): Promise<PrReviewReport | null> {
  const response = await ghGraphql(
    host,
    REVIEW_QUERY,
    { owner: repo.owner, name: repo.name, n: number },
    REVIEW_RESPONSE,
    {
      label: `gh api graphql (review threads on ${repo.slug}#${number})`,
      fix: `gh pr view ${number} --repo ${repo.slug} --json number   # confirm the pull request is visible to this token`,
    },
  );
  const pull = response.data.repository?.pullRequest;
  if (pull === undefined || pull === null) return null;
  const head = pull.commits.nodes[0]?.commit ?? null;
  const reviews: readonly PrReview[] = pull.latestOpinionatedReviews.nodes.map((review) => ({
    state: review.state,
    author: loginOf(review.author),
    submittedAt: review.submittedAt,
    commit: review.commit?.oid ?? null,
    stale: review.commit?.oid !== pull.headRefOid,
  }));
  return {
    repo: repo.slug,
    number: pull.number,
    url: pull.url,
    headSha: pull.headRefOid,
    headCommittedAt: head?.committedDate ?? null,
    reviewDecision: pull.reviewDecision,
    decidingReview: decidingReview(reviews, pull.reviewDecision),
    truncated: pull.reviewThreads.pageInfo.hasNextPage,
    threads: orderThreads(
      pull.reviewThreads.nodes.map((thread) => ({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        commentCount: thread.comments.totalCount,
        comments: thread.comments.nodes.map((comment) => ({
          author: loginOf(comment.author),
          createdAt: comment.createdAt,
          body: comment.body,
        })),
      })),
    ),
  };
}

export const RESOLVE_MUTATION =
  'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}';

// Both levels nullable, because both are nullable in GitHub's schema (`ResolveReviewThreadPayload.
// thread` is an OBJECT, not a NON_NULL one) — and a payload that does not carry the thread it
// claims to have resolved is exactly the answer this command must not read as a success.
const RESOLVE_RESPONSE = t.object({
  data: t.object({
    resolveReviewThread: t.nullable(
      t.object({ thread: t.nullable(t.object({ id: t.string, isResolved: t.boolean })) }),
    ),
  }),
});

/**
 * Marks the CONVERSATION resolved, and says only that. Whether the finding is addressed is a fact
 * about the code, which no GitHub mutation can observe — the summary this returns feeds a line
 * that refuses to conflate the two.
 */
export async function resolveThread(host: GhHost, threadId: string): Promise<string> {
  const fix = 'x pr review --json   # the id column is the thread id this mutation takes';
  const label = `gh api graphql (resolve ${threadId})`;
  const response = await ghGraphql(host, RESOLVE_MUTATION, { t: threadId }, RESOLVE_RESPONSE, {
    label,
    fix,
  });
  const thread = response.data.resolveReviewThread?.thread;
  // A mutation that exited 0 and did not come back saying the thread is resolved has not told us
  // it worked, and reporting `resolved` off the exit code alone is how a command claims an effect
  // it never observed.
  if (thread?.isResolved !== true) {
    throw new GhResponseInvalidError({
      label,
      detail: 'the mutation returned no resolved thread',
      fix,
    });
  }
  // The id GitHub echoed, not the one that was sent: they are the same string on every success,
  // and reporting the one we sent would make a summary that cannot tell a hit from a miss.
  return thread.id;
}

export const REPLY_MUTATION =
  'mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(' +
  'input:{pullRequestReviewThreadId:$t,body:$b}){comment{id url}}}';

const REPLY_RESPONSE = t.object({
  data: t.object({
    addPullRequestReviewThreadReply: t.nullable(
      t.object({ comment: t.nullable(t.object({ id: t.string, url: t.string })) }),
    ),
  }),
});

/** A reply lands IN the thread, which is the only place a reviewer reads it. Returns its URL. */
export async function replyToThread(host: GhHost, threadId: string, body: string): Promise<string> {
  const fix = 'x pr review --json   # the id column is the thread id this mutation takes';
  const label = `gh api graphql (reply on ${threadId})`;
  const response = await ghGraphql(host, REPLY_MUTATION, { t: threadId, b: body }, REPLY_RESPONSE, {
    label,
    fix,
  });
  const url = response.data.addPullRequestReviewThreadReply?.comment?.url;
  if (url === undefined || url === null) {
    throw new GhResponseInvalidError({ label, detail: 'the mutation posted no comment', fix });
  }
  return url;
}
