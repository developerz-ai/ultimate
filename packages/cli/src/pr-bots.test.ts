// The bots summary on recorded bodies: a review bot that said "I did not review this" is flagged,
// and one that reviewed after saying so is not. No network: every body here is a fixture.

import { describe, expect, test } from 'bun:test';
import type { PrIssueComment, PrReviewEntry } from './pr-activity';
import { botNotice, botsSummary } from './pr-bots';

/** CodeRabbit's rate-limit notice, as it posts it (trimmed of the long tips that follow). */
const CODERABBIT_RATE_LIMITED = [
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->',
  '',
  '> [!WARNING]',
  '> ## Rate limit exceeded',
  '>',
  '> @sebi has exceeded the limit for the number of commits or files that can be reviewed per hour. Please wait **12 minutes and 3 seconds** before requesting another review.',
].join('\n');

/** CodeRabbit's skip notice for a pull request over its file limit. */
const CODERABBIT_TOO_MANY_FILES = [
  '<!-- This is an auto-generated comment: skip review by coderabbit.ai -->',
  '',
  '> [!IMPORTANT]',
  '> ## Review skipped',
  '>',
  '> Too many files!',
  '>',
  '> 162 files out of 312 files are above the max files limit of 150.',
].join('\n');

const comment = (over: Partial<PrIssueComment>): PrIssueComment => ({
  id: 'IC_1',
  author: 'coderabbitai',
  isBot: true,
  createdAt: '2026-11-09T10:00:00Z',
  updatedAt: '2026-11-09T10:00:00Z',
  url: 'https://github.com/o/r/pull/1#issuecomment-1',
  body: 'a walkthrough',
  ...over,
});

const review = (over: Partial<PrReviewEntry>): PrReviewEntry => ({
  id: 'PRR_1',
  state: 'COMMENTED',
  author: 'coderabbitai',
  isBot: true,
  submittedAt: '2026-11-09T09:00:00Z',
  commit: 'abc',
  stale: false,
  url: 'https://github.com/o/r/pull/1#pullrequestreview-1',
  body: '**Actionable comments posted: 2**',
  ...over,
});

describe('unit · a bot notice is recognised by what it says', () => {
  test('CodeRabbit rate limit', () => {
    expect(botNotice(CODERABBIT_RATE_LIMITED)).toEqual({
      kind: 'rate-limited',
      excerpt: 'Rate limit exceeded',
    });
  });

  test('CodeRabbit "review limit" wording is a rate limit too', () => {
    expect(
      botNotice('> ## Review limit reached\n> You have used every review this month.'),
    ).toEqual({ kind: 'rate-limited', excerpt: 'Review limit reached' });
  });

  test('CodeRabbit skipped for too many files', () => {
    expect(botNotice(CODERABBIT_TOO_MANY_FILES)).toEqual({
      kind: 'skipped',
      excerpt: 'Review skipped',
    });
  });

  test('a notice heading without a marker still counts', () => {
    expect(botNotice('> [!WARNING]\n> ## Rate limit exceeded\n> wait 5 minutes')).toEqual({
      kind: 'rate-limited',
      excerpt: 'Rate limit exceeded',
    });
  });

  test('the phrases in prose, or a heading that merely mentions them, are no notice', () => {
    expect(botNotice('Handle rate limit exceeded from the upstream API')).toBeNull();
    expect(botNotice('Too many files changed here; the review limit is fine')).toBeNull();
    expect(botNotice('## Handle rate limit exceeded responses')).toBeNull();
  });

  test('an ordinary review body is no notice', () => {
    expect(botNotice('**Actionable comments posted: 2**\n\nsee the threads')).toBeNull();
    expect(botNotice('')).toBeNull();
  });
});

describe('unit · the bots summary', () => {
  test('a notice newer than the bot last review blocks it', () => {
    const bots = botsSummary(
      [review({})],
      [comment({ body: CODERABBIT_RATE_LIMITED, updatedAt: '2026-11-09T10:30:00Z' })],
    );
    expect(bots).toEqual([
      {
        login: 'coderabbitai',
        reviews: 1,
        comments: 1,
        lastReviewAt: '2026-11-09T09:00:00Z',
        notice: {
          kind: 'rate-limited',
          excerpt: 'Rate limit exceeded',
          at: '2026-11-09T10:30:00Z',
          url: 'https://github.com/o/r/pull/1#issuecomment-1',
        },
        blocked: true,
      },
    ]);
  });

  // CodeRabbit edits its summary comment in place: `updatedAt` dates the notice, not `createdAt`.
  test('the notice is dated by its last edit', () => {
    const [bot] = botsSummary(
      [review({ submittedAt: '2026-11-09T11:00:00Z' })],
      [
        comment({
          body: CODERABBIT_TOO_MANY_FILES,
          createdAt: '2026-11-09T08:00:00Z',
          updatedAt: '2026-11-09T12:00:00Z',
        }),
      ],
    );
    expect(bot?.blocked).toBe(true);
    expect(bot?.notice?.kind).toBe('skipped');
  });

  test('a review after the notice means the bot did review: not blocked', () => {
    const [bot] = botsSummary(
      [review({ submittedAt: '2026-11-09T11:00:00Z' })],
      [comment({ body: CODERABBIT_RATE_LIMITED, updatedAt: '2026-11-09T10:30:00Z' })],
    );
    expect(bot?.notice?.kind).toBe('rate-limited');
    expect(bot?.blocked).toBe(false);
  });

  test('humans are not bots, and a bot with no notice is listed unblocked', () => {
    const bots = botsSummary(
      [review({ author: 'sebi', isBot: false, body: CODERABBIT_RATE_LIMITED })],
      [comment({ author: 'github-actions[bot]', body: 'deploy preview ready' })],
    );
    expect(bots).toEqual([
      {
        login: 'github-actions[bot]',
        reviews: 0,
        comments: 1,
        lastReviewAt: null,
        notice: null,
        blocked: false,
      },
    ]);
  });

  // A formal review IS a review: whatever its body says, the bot reviewed. Only an issue comment
  // can be the notice that it did not.
  test('a review body is never a notice, whatever it says', () => {
    const [bot] = botsSummary(
      [review({ body: CODERABBIT_RATE_LIMITED, submittedAt: '2026-11-09T09:00:00Z' })],
      [],
    );
    expect(bot?.notice).toBeNull();
    expect(bot?.blocked).toBe(false);
    expect(bot?.lastReviewAt).toBe('2026-11-09T09:00:00Z');
  });

  test('an ordinary review discussing rate limits and skipped files is not blocked', () => {
    const prose = [
      '**Actionable comments posted: 2**',
      '',
      'Handle rate limit exceeded from the upstream API before retrying.',
      'The review limit and max files limit in `config.ts` are never read; too many files are',
      'skipped. Review skipped paths in the loader too.',
      '',
      '### Handle rate limit exceeded responses',
    ].join('\n');
    const [bot] = botsSummary(
      [review({ body: prose })],
      [comment({ body: prose, updatedAt: '2026-11-09T10:30:00Z' })],
    );
    expect(bot?.notice).toBeNull();
    expect(bot?.blocked).toBe(false);
  });
});
