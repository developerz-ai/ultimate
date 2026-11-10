// Reviews and issue comments, read out of the one review query beside the threads. A recorded
// payload stands in for GitHub: no test here reaches the network.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from './app-root';
import { BODY_LINES, prCommand } from './cmd-pr';
import type { ExecResult, Runner } from './exec';
import { msg } from './messages';
import type { CommandResult } from './output';
import { parseArgs } from './parse';
import { ACTIVITY_PAGE } from './pr-activity';
import { fetchReviewReport, REVIEW_QUERY } from './pr-threads';

const REPO = { owner: 'o', name: 'r', slug: 'o/r' };
const HEAD = '003e896c1082f33fa92b29d6d2c4862f332dfaf1';
const OLDER = 'f82fd0dc814acf362fdab6725d6ea05429fe1d3f';

const host = (stdout: string): { runner: Runner; cwd: string } => ({
  cwd: '/repo',
  runner: async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout,
    stderr: '',
    durationMs: 1,
  }),
});

/** A pull request with one human approval, one bot review, and two issue comments. */
const ACTIVITY_PAYLOAD = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        headRefOid: HEAD,
        reviewDecision: 'APPROVED',
        commits: { nodes: [{ commit: { oid: HEAD, committedDate: '2026-11-09T09:00:00Z' } }] },
        latestOpinionatedReviews: { nodes: [] },
        reviews: {
          totalCount: 3,
          nodes: [
            {
              id: 'PRR_bot',
              state: 'COMMENTED',
              body: '**Actionable comments posted: 1**',
              submittedAt: '2026-11-09T08:00:00Z',
              url: 'https://github.com/o/r/pull/7#pullrequestreview-1',
              author: { login: 'coderabbitai', __typename: 'Bot' },
              commit: { oid: OLDER },
            },
            {
              id: 'PRR_human',
              state: 'APPROVED',
              body: 'ship it',
              submittedAt: '2026-11-09T09:30:00Z',
              url: 'https://github.com/o/r/pull/7#pullrequestreview-2',
              author: { login: 'sebi', __typename: 'User' },
              commit: { oid: HEAD },
            },
          ],
        },
        comments: {
          totalCount: 2,
          nodes: [
            {
              id: 'IC_1',
              body: '> ## Rate limit exceeded\n> wait 12 minutes',
              createdAt: '2026-11-09T09:01:00Z',
              updatedAt: '2026-11-09T09:05:00Z',
              url: 'https://github.com/o/r/pull/7#issuecomment-1',
              author: { login: 'coderabbitai', __typename: 'Bot' },
            },
            {
              id: 'IC_2',
              // Longer than `BODY_LINES`, so the clamp has something to cut.
              body: Array.from({ length: 25 }, (_, index) => `line ${index}`).join('\n'),
              createdAt: '2026-11-09T09:10:00Z',
              updatedAt: '2026-11-09T09:10:00Z',
              url: 'https://github.com/o/r/pull/7#issuecomment-2',
              author: null,
            },
          ],
        },
        reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
      },
    },
  },
});

describe('unit · the review query carries the whole conversation', () => {
  test('reviews and issue comments are asked for in the same document, newest page', () => {
    expect(REVIEW_QUERY).toContain(`reviews(last:${ACTIVITY_PAGE})`);
    expect(REVIEW_QUERY).toContain(`comments(last:${ACTIVITY_PAGE})`);
    expect(REVIEW_QUERY).toContain('__typename');
  });

  test('every review comes back with its verdict and body, staleness by commit', async () => {
    const report = await fetchReviewReport(host(ACTIVITY_PAYLOAD), REPO, 7);
    expect(report?.reviews.map((review) => [review.author, review.state, review.isBot])).toEqual([
      ['coderabbitai', 'COMMENTED', true],
      ['sebi', 'APPROVED', false],
    ]);
    expect(report?.reviews.map((review) => review.stale)).toEqual([true, false]);
    expect(report?.reviews[1]?.body).toBe('ship it');
    // Three exist, one page carried two.
    expect(report?.reviewsTruncated).toBe(true);
  });

  test('issue comments come back with both dates, and a deleted author is kept', async () => {
    const report = await fetchReviewReport(host(ACTIVITY_PAYLOAD), REPO, 7);
    expect(report?.comments.map((comment) => comment.author)).toEqual(['coderabbitai', 'ghost']);
    expect(report?.comments[0]?.updatedAt).toBe('2026-11-09T09:05:00Z');
    expect(report?.comments[1]?.isBot).toBe(false);
    expect(report?.commentsTruncated).toBe(false);
  });
});

/** `x pr review --json` against the recorded payload, through the command itself. */
async function reviewResult(
  argv: readonly string[],
  payload = ACTIVITY_PAYLOAD,
): Promise<CommandResult> {
  const runner: Runner = async (command): Promise<ExecResult> => ({
    command,
    code: 0,
    ok: true,
    stdout: command.join(' ').startsWith('gh api graphql') ? payload : '',
    stderr: '',
    durationMs: 1,
  });
  const result = await prCommand.run({
    args: parseArgs(['pr', 'review', '--repo', 'o/r', '--pr', '7', ...argv], [prCommand.spec]),
    cwd: '/repo',
    runner,
    env: {},
    bunVersion: REQUIRED_BUN,
  });
  return result;
}

const reviewData = async (argv: readonly string[]): Promise<Record<string, unknown>> =>
  (await reviewResult(argv)).data as Record<string, unknown>;

describe('unit · x pr review --json: reviews, threads, comments and bots, side by side', () => {
  test('the existing fields stay, and the three arrays plus the bots summary are added', async () => {
    const data = await reviewData([]);
    for (const field of ['repo', 'pr', 'reviewDecision', 'review', 'counts', 'threads']) {
      expect([field, field in data]).toEqual([field, true]);
    }
    expect(data['reviews']).toEqual([
      {
        id: 'PRR_bot',
        state: 'COMMENTED',
        author: 'coderabbitai',
        isBot: true,
        submittedAt: '2026-11-09T08:00:00Z',
        commit: OLDER,
        stale: true,
        url: 'https://github.com/o/r/pull/7#pullrequestreview-1',
        body: '**Actionable comments posted: 1**',
        bodyLinesHidden: 0,
      },
      {
        id: 'PRR_human',
        state: 'APPROVED',
        author: 'sebi',
        isBot: false,
        submittedAt: '2026-11-09T09:30:00Z',
        commit: HEAD,
        stale: false,
        url: 'https://github.com/o/r/pull/7#pullrequestreview-2',
        body: 'ship it',
        bodyLinesHidden: 0,
      },
    ]);
    expect((data['comments'] as readonly { id: string }[]).map((row) => row.id)).toEqual([
      'IC_1',
      'IC_2',
    ]);
    expect(data['reviewsTruncated']).toBe(true);
    expect(data['commentsTruncated']).toBe(false);
  });

  // The adopter's case: the bot's last review predates its rate-limit notice, so the absence of
  // new threads is a review that never happened — and `--json` says so in one field.
  test('a rate-limited review bot is flagged blocked', async () => {
    const data = await reviewData([]);
    expect(data['bots']).toEqual([
      {
        login: 'coderabbitai',
        reviews: 1,
        comments: 1,
        lastReviewAt: '2026-11-09T08:00:00Z',
        notice: {
          kind: 'rate-limited',
          excerpt: 'Rate limit exceeded',
          at: '2026-11-09T09:05:00Z',
          url: 'https://github.com/o/r/pull/7#issuecomment-1',
        },
        blocked: true,
      },
    ]);
  });

  test('a body is clamped like a thread body, and --full lifts it', async () => {
    type Row = { body: string; bodyLinesHidden: number };
    const clamped = (await reviewData([]))['comments'] as readonly Row[];
    expect(clamped[1]?.bodyLinesHidden).toBe(25 - BODY_LINES);
    expect(clamped[1]?.body.split('\n').length).toBe(BODY_LINES);
    const full = (await reviewData(['--full']))['comments'] as readonly Row[];
    expect(full[1]?.bodyLinesHidden).toBe(0);
    expect(full[1]?.body.split('\n').length).toBe(25);
  });
});

describe('unit · x pr review, human: the conversation in two short lines', () => {
  test('the counts, then a blocked bot — before the threads', async () => {
    const lines = (await reviewResult([])).lines ?? [];
    const activity = msg('cli.pr.review.activity', { reviews: 2, comments: 2, bots: 1 });
    const blocked = msg('cli.pr.bot.blocked', {
      login: 'coderabbitai',
      kind: 'rate-limited',
      excerpt: 'Rate limit exceeded',
      at: '2026-11-09T09:05:00Z',
      url: 'https://github.com/o/r/pull/7#issuecomment-1',
    });
    expect(lines).toContain(activity);
    expect(lines).toContain(blocked);
    expect(lines.indexOf(activity)).toBeLessThan(lines.indexOf(blocked));
    expect(lines.some((line) => line.includes('⟦'))).toBe(false);
  });

  // The bot reviewed after its notice: the notice is history, said once, never as "did not review".
  test('a notice the bot reviewed past is a notice line, not a blocked one', async () => {
    const reviewedAfter = ACTIVITY_PAYLOAD.replace(
      '"submittedAt":"2026-11-09T08:00:00Z"',
      '"submittedAt":"2026-11-09T10:00:00Z"',
    );
    expect(reviewedAfter).not.toBe(ACTIVITY_PAYLOAD);
    const lines = (await reviewResult([], reviewedAfter)).lines ?? [];
    expect(lines).toContain(
      msg('cli.pr.bot.notice', {
        login: 'coderabbitai',
        kind: 'rate-limited',
        at: '2026-11-09T09:05:00Z',
        reviewed: '2026-11-09T10:00:00Z',
      }),
    );
    expect(lines.some((line) => line.includes('did not review'))).toBe(false);
  });
});
