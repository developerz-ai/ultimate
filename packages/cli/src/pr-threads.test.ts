// The review query and what it becomes. Driven with a captured GitHub payload rather than a live
// one, so the two hazards can be pinned: a `reviewDecision` that predates the head commit, and a
// thread whose anchor line has gone `null` because the diff moved under it.

import { describe, expect, test } from 'bun:test';
import type { ExecResult, Runner } from './exec';
import type { PrThread } from './pr-threads';
import {
  COMMENT_PAGE,
  decidingReview,
  fetchReviewReport,
  orderThreads,
  REPLY_MUTATION,
  RESOLVE_MUTATION,
  REVIEW_QUERY,
  replyToThread,
  resolveThread,
  THREAD_PAGE,
} from './pr-threads';

const REPO = { owner: 'developerz-ai', name: 'ultimate', slug: 'developerz-ai/ultimate' };
const HEAD = '003e896c1082f33fa92b29d6d2c4862f332dfaf1';
const OLDER = 'f82fd0dc814acf362fdab6725d6ea05429fe1d3f';

/** A runner that answers one stdout and records the argv it was asked for. */
function answering(stdout: string, code = 0): { runner: Runner; ran: string[][] } {
  const ran: string[][] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    ran.push([...command]);
    return {
      command,
      code,
      ok: code === 0,
      stdout,
      stderr: code === 0 ? '' : stdout,
      durationMs: 1,
    };
  };
  return { runner, ran };
}

const hostFor = (stdout: string) => {
  const { runner, ran } = answering(stdout);
  return { host: { runner, cwd: '/repo' }, ran };
};

const thread = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'PRRT_one',
  isResolved: false,
  isOutdated: false,
  path: 'packages/cli/src/gh.ts',
  line: 42,
  originalLine: 42,
  comments: {
    totalCount: 1,
    nodes: [{ author: { login: 'coderabbitai' }, createdAt: '2026-08-20T18:20:36Z', body: 'a\nb' }],
  },
  ...over,
});

interface PayloadOptions {
  readonly reviews?: readonly Record<string, unknown>[];
  readonly threads?: readonly Record<string, unknown>[];
  readonly hasNextPage?: boolean;
  readonly decision?: string | null;
  readonly pullRequest?: null;
}

const payload = (options: PayloadOptions = {}): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest:
          options.pullRequest === null
            ? null
            : {
                number: 238,
                url: 'https://github.com/developerz-ai/ultimate/pull/238',
                headRefOid: HEAD,
                reviewDecision:
                  options.decision === undefined ? 'CHANGES_REQUESTED' : options.decision,
                commits: {
                  nodes: [{ commit: { oid: HEAD, committedDate: '2026-08-20T18:49:41Z' } }],
                },
                latestOpinionatedReviews: {
                  nodes: options.reviews ?? [
                    {
                      state: 'CHANGES_REQUESTED',
                      submittedAt: '2026-08-20T18:20:38Z',
                      author: { login: 'coderabbitai' },
                      commit: { oid: OLDER },
                    },
                  ],
                },
                reviewThreads: {
                  pageInfo: { hasNextPage: options.hasNextPage ?? false },
                  nodes: options.threads ?? [thread()],
                },
              },
      },
    },
  });

describe('unit · the query asks for what the report states', () => {
  test('the page sizes are built from the constants the report reads back', () => {
    expect(REVIEW_QUERY).toContain(`reviewThreads(first:${THREAD_PAGE})`);
    expect(REVIEW_QUERY).toContain(`comments(first:${COMMENT_PAGE})`);
  });

  // Each of these answers a question no other field can: `headRefOid` dates the review,
  // `originalLine` locates a thread whose `line` has gone null, `isResolved` separates a closed
  // conversation from an open one, and `id` is the only handle the resolve mutation takes.
  test('every field the two hazards depend on is requested', () => {
    for (const field of [
      'headRefOid',
      'reviewDecision',
      'latestOpinionatedReviews',
      'originalLine',
      'isResolved',
      'isOutdated',
      'pageInfo{hasNextPage}',
    ]) {
      expect([field, REVIEW_QUERY.includes(field)]).toEqual([field, true]);
    }
  });

  test('the mutations name the input fields GitHub declares, and read the payload back', () => {
    expect(RESOLVE_MUTATION).toContain('resolveReviewThread(input:{threadId:$t})');
    expect(RESOLVE_MUTATION).toContain('isResolved');
    expect(REPLY_MUTATION).toContain('pullRequestReviewThreadId:$t');
    expect(REPLY_MUTATION).toContain('body:$b');
  });
});

describe('unit · a review decision outlives the push that answered it', () => {
  test('a decision submitted against an older commit is reported stale, with both oids', async () => {
    const { host } = hostFor(payload());
    const report = await fetchReviewReport(host, REPO, 238);
    expect(report?.reviewDecision).toBe('CHANGES_REQUESTED');
    expect(report?.decidingReview?.stale).toBe(true);
    expect(report?.decidingReview?.commit).toBe(OLDER);
    expect(report?.headSha).toBe(HEAD);
  });

  test('a decision submitted against the head is not stale', async () => {
    const { host } = hostFor(
      payload({
        reviews: [
          {
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-08-20T18:50:00Z',
            author: { login: 'coderabbitai' },
            commit: { oid: HEAD },
          },
        ],
      }),
    );
    const report = await fetchReviewReport(host, REPO, 238);
    expect(report?.decidingReview?.stale).toBe(false);
  });

  // The newest review is usually a `COMMENTED` one, which decides nothing. Dating the decision
  // from it would call a stale `CHANGES_REQUESTED` current — which is the whole hazard, inverted.
  test('the deciding review is the one that STATES the decision, not the newest', () => {
    const reviews = [
      {
        state: 'CHANGES_REQUESTED',
        author: 'a',
        submittedAt: '2026-08-20T18:20:38Z',
        commit: OLDER,
        stale: true,
      },
      {
        state: 'COMMENTED',
        author: 'b',
        submittedAt: '2026-08-20T18:51:19Z',
        commit: HEAD,
        stale: false,
      },
    ];
    expect(decidingReview(reviews, 'CHANGES_REQUESTED')?.state).toBe('CHANGES_REQUESTED');
    expect(decidingReview(reviews, 'CHANGES_REQUESTED')?.stale).toBe(true);
    // With no decision at all, the newest is the only defensible answer.
    expect(decidingReview(reviews, null)?.author).toBe('b');
    expect(decidingReview([], 'APPROVED')).toBe(null);
  });
});

describe('unit · threads become rows', () => {
  test('an outdated thread keeps a locator, because line is null and originalLine is not', async () => {
    const { host } = hostFor(
      payload({ threads: [thread({ isOutdated: true, line: null, originalLine: 305 })] }),
    );
    const report = await fetchReviewReport(host, REPO, 238);
    expect(report?.threads[0]?.line).toBe(null);
    expect(report?.threads[0]?.originalLine).toBe(305);
    expect(report?.threads[0]?.isOutdated).toBe(true);
  });

  test('a comment with no author is kept, not dropped with the finding on it', async () => {
    const { host } = hostFor(
      payload({
        threads: [
          thread({
            comments: {
              totalCount: 3,
              nodes: [{ author: null, createdAt: '2026-08-20T00:00:00Z', body: 'gone' }],
            },
          }),
        ],
      }),
    );
    const report = await fetchReviewReport(host, REPO, 238);
    expect(report?.threads[0]?.comments[0]?.author).toBe('ghost');
    // Three comments exist and one page carried one: the count is what says so.
    expect(report?.threads[0]?.commentCount).toBe(3);
  });

  test('a second page of threads is reported, never silently dropped', async () => {
    const { host } = hostFor(payload({ hasNextPage: true }));
    expect((await fetchReviewReport(host, REPO, 238))?.truncated).toBe(true);
  });

  // The resolved one sorts FIRST on path and line, so an order that only sorted on those would
  // put a closed conversation at the top of the list an agent works down.
  test('unresolved threads sort first, then by path and line', () => {
    const row = (over: Partial<PrThread>): PrThread => ({
      id: 'x',
      path: 'a.ts',
      line: 1,
      originalLine: 1,
      isResolved: false,
      isOutdated: false,
      comments: [],
      commentCount: 0,
      ...over,
    });
    const rows = [
      row({ id: 'c', path: 'a.ts', line: 1, isResolved: true }),
      row({ id: 'b', path: 'b.ts', line: 2 }),
      row({ id: 'a', path: 'a.ts', line: 7 }),
    ];
    expect(orderThreads(rows).map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
  });

  test('a pull request GitHub answers null for is a null report, never a crash', async () => {
    const { host } = hostFor(payload({ pullRequest: null }));
    expect(await fetchReviewReport(host, REPO, 238)).toBe(null);
  });

  test('the query goes out with the repo and number as typed variables', async () => {
    const { host, ran } = hostFor(payload());
    await fetchReviewReport(host, REPO, 238);
    expect(ran[0]?.slice(0, 3)).toEqual(['gh', 'api', 'graphql']);
    expect(ran[0]).toContain('owner=developerz-ai');
    expect(ran[0]).toContain('name=ultimate');
    expect(ran[0]).toContain('n=238');
    // The number is typed, or `$n:Int!` refuses it.
    expect(ran[0]?.[ran[0].indexOf('n=238') - 1]).toBe('-F');
  });
});

describe('unit · resolving reports what GitHub confirmed, never what was sent', () => {
  test('the echoed thread id comes back', async () => {
    const { host, ran } = hostFor(
      JSON.stringify({
        data: { resolveReviewThread: { thread: { id: 'PRRT_one', isResolved: true } } },
      }),
    );
    expect(await resolveThread(host, 'PRRT_one')).toBe('PRRT_one');
    expect(ran[0]).toContain('t=PRRT_one');
  });

  // This is the real payload for an id GitHub cannot resolve — measured against the live API.
  test('a null payload is a refusal, not a reported success', async () => {
    const { host } = hostFor(JSON.stringify({ data: { resolveReviewThread: null } }));
    const error = await resolveThread(host, 'NOPE').then(
      () => ({}) as { code?: string },
      (thrown: unknown) => thrown as { code?: string },
    );
    expect(error.code).toBe('X_GH_RESPONSE_INVALID');
  });

  test('a thread that comes back unresolved is refused too', async () => {
    const { host } = hostFor(
      JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'x', isResolved: false } } } }),
    );
    const error = await resolveThread(host, 'x').then(
      () => ({}) as { code?: string },
      (thrown: unknown) => thrown as { code?: string },
    );
    expect(error.code).toBe('X_GH_RESPONSE_INVALID');
  });

  test('a reply answers with the comment URL, and the body rides untyped', async () => {
    const { host, ran } = hostFor(
      JSON.stringify({
        data: {
          addPullRequestReviewThreadReply: {
            comment: { id: 'c1', url: 'https://github.com/o/r/pull/1#discussion_r1' },
          },
        },
      }),
    );
    expect(await replyToThread(host, 'PRRT_one', '@fixed in 0f3a91c')).toBe(
      'https://github.com/o/r/pull/1#discussion_r1',
    );
    expect(ran[0]).toContain('b=@fixed in 0f3a91c');
  });
});
