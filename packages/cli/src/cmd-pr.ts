// `x pr review|resolve|reply` — the inline review, in a terminal. `gh pr view --comments` prints
// ISSUE comments, so the findings a reviewer anchored to a line are invisible to it and the thread
// id needed to resolve one exists nowhere a human can copy. This command is the one place that
// query lives, and the one place the two facts a reviewer's verdict hides behind are stated: a
// `reviewDecision` outlives the push that answered it, and a RESOLVED thread is a closed
// conversation rather than a fixed finding.

import type { CliCommand, CommandContext } from './command';
import {
  BadFlagError,
  MissingPositionalError,
  MissingSubcommandError,
  UnknownCommandError,
} from './errors';
import { parseIntFlag } from './flag-number';
import { PrNotFoundError, resolvePrNumber, resolveRepo } from './gh-target';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';
import type { PrReviewReport, PrThread } from './pr-threads';
import { fetchReviewReport, replyToThread, resolveThread, THREAD_PAGE } from './pr-threads';

export const PR_SUBCOMMANDS = ['review', 'resolve', 'reply'] as const;

/**
 * Every catalog key this command renders, declared. `msg()` answers `⟦key⟧` for a key nobody
 * added — loud in a terminal and SILENT to a build — so the list is exported and
 * `cmd-pr.test.ts` holds it against the catalog, which turns a missing string into a failing test
 * instead of a rendered artefact of one.
 */
export const PR_MESSAGE_KEYS = [
  'cli.pr.review.count',
  'cli.pr.review.none',
  'cli.pr.review.decision',
  'cli.pr.review.stale',
  'cli.pr.review.current',
  'cli.pr.review.undecided',
  'cli.pr.review.truncated',
  'cli.pr.thread.open',
  'cli.pr.thread.closed',
  'cli.pr.thread.outdated',
  'cli.pr.thread.comment',
  'cli.pr.thread.more',
  'cli.pr.body.truncated',
  'cli.pr.line.unknown',
  'cli.pr.resolved',
  'cli.pr.replied',
] as const;

/** Lines of each comment body shown before it is cut. CodeRabbit's run to several thousand. */
export const BODY_LINES = 20;

export const prCommand: CliCommand = {
  spec: {
    name: 'pr',
    summary: 'inline review threads: list them with their ids, resolve one, reply in one',
    usage:
      'x pr review [--pr <n>] [--repo owner/name] [--all] [--full] | x pr resolve <thread-id> | x pr reply <thread-id> --body "…"',
    subcommands: PR_SUBCOMMANDS,
    flags: [
      { name: 'repo', type: 'string', summary: 'owner/name; the checkout own remote by default' },
      { name: 'pr', type: 'string', summary: 'pull request number; this branch own by default' },
      { name: 'all', type: 'boolean', summary: 'review: resolved threads too, not just open ones' },
      { name: 'full', type: 'boolean', summary: 'review: whole comment bodies, never truncated' },
      { name: 'body', type: 'string', summary: 'reply: the comment text to post in the thread' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    // No `defaultSubcommand`: `resolve` and `reply` both WRITE to a pull request, so "whatever the
    // caller left out" is not a safe guess for any of the three.
    const sub = ctx.args.subcommand;
    if (sub === undefined) {
      throw new MissingSubcommandError({ command: 'pr', known: PR_SUBCOMMANDS });
    }
    if (sub === 'review') return runReview(ctx);
    if (sub === 'resolve') return runResolve(ctx);
    if (sub === 'reply') return runReply(ctx);
    throw new UnknownCommandError({
      path: `pr ${sub}`,
      known: PR_SUBCOMMANDS,
      suggestion: 'help pr',
    });
  },
};

/** `--pr` bounds, declared once so the refusal and the resolution cannot disagree about them. */
const PR_NUMBER = {
  name: 'pr',
  command: 'pr review',
  min: 1,
  example: 'x pr review --pr 241 --json',
} as const;

async function runReview(ctx: CommandContext): Promise<CommandResult> {
  // 'pr review', not 'pr': `resolveRepo` builds its refusal's `fix:` from this word, and
  // `x pr --repo …` is a command that throws `MissingSubcommandError` — a fix line that
  // reproduces its own failure is the shape `MissingSubcommandError`'s own doc block warns about.
  const repo = await resolveRepo(ctx, 'pr review', flagString(ctx.args, 'repo'));
  const raw = flagString(ctx.args, 'pr');
  const number =
    raw === undefined ? await resolvePrNumber(ctx, repo) : parseIntFlag(raw, PR_NUMBER);
  const report = await fetchReviewReport(ctx, repo, number);
  if (report === null) {
    throw new PrNotFoundError({ detail: `${repo.slug}#${number} answered no pull request` });
  }
  const all = flagBool(ctx.args, 'all');
  const shown = all ? report.threads : report.threads.filter((thread) => !thread.isResolved);
  const bodyLines = flagBool(ctx.args, 'full') ? Number.POSITIVE_INFINITY : BODY_LINES;
  const unresolved = report.threads.filter((thread) => !thread.isResolved).length;
  return {
    // An inspection command, so the verdict is "the report was produced" and never "the review is
    // clean": an agent loops read → edit → resolve on this output, and a non-zero exit for every
    // open thread would report the work still to do as a failure of the command that listed it.
    ok: true,
    command: 'pr',
    summary:
      report.threads.length === 0
        ? msg('cli.pr.review.none', { repo: report.repo, pr: report.number })
        : msg('cli.pr.review.count', {
            unresolved,
            resolved: report.threads.length - unresolved,
            repo: report.repo,
            pr: report.number,
          }),
    lines: [...decisionLines(report), ...shown.flatMap((thread) => threadLines(thread, bodyLines))],
    data: reviewJson(report, shown, bodyLines, unresolved),
  };
}

/**
 * The staleness hazard, rendered before the threads. A `reviewDecision` survives every later push,
 * so `CHANGES_REQUESTED` on a branch that has since been fixed reads exactly like one that has
 * not — and the answer is the commit the review was submitted against, which is a fact rather than
 * a timestamp comparison across a push.
 */
function decisionLines(report: PrReviewReport): readonly string[] {
  const review = report.decidingReview;
  if (review === null) {
    return [msg('cli.pr.review.undecided'), ...truncationLines(report)];
  }
  return [
    msg('cli.pr.review.decision', {
      decision: report.reviewDecision ?? review.state,
      author: review.author,
      submitted: review.submittedAt ?? '',
    }),
    review.stale
      ? msg('cli.pr.review.stale', {
          commit: short(review.commit),
          head: short(report.headSha),
          committed: report.headCommittedAt ?? '',
        })
      : msg('cli.pr.review.current', { head: short(report.headSha) }),
    ...truncationLines(report),
  ];
}

const truncationLines = (report: PrReviewReport): readonly string[] =>
  report.truncated ? [msg('cli.pr.review.truncated', { count: THREAD_PAGE })] : [];

/** Seven characters is what every GitHub UI shows, and enough to paste into `git show`. */
const short = (sha: string | null): string => (sha === null ? '' : sha.slice(0, 7));

const lineOf = (thread: PrThread): string =>
  thread.line === null
    ? (thread.originalLine?.toString() ?? msg('cli.pr.line.unknown'))
    : String(thread.line);

function threadLines(thread: PrThread, bodyLines: number): readonly string[] {
  const head = thread.isResolved ? 'cli.pr.thread.closed' : 'cli.pr.thread.open';
  const out = [msg(head, { path: thread.path, line: lineOf(thread), id: thread.id })];
  if (thread.isOutdated) out.push(msg('cli.pr.thread.outdated', { line: lineOf(thread) }));
  for (const comment of thread.comments) {
    out.push(
      msg('cli.pr.thread.comment', { author: comment.author, createdAt: comment.createdAt }),
    );
    const clamped = clampBody(comment.body, bodyLines);
    for (const line of clamped.lines) out.push(`      | ${line}`);
    if (clamped.hidden > 0) out.push(msg('cli.pr.body.truncated', { hidden: clamped.hidden }));
  }
  const hidden = thread.commentCount - thread.comments.length;
  if (hidden > 0) out.push(msg('cli.pr.thread.more', { hidden }));
  return out;
}

/**
 * A review body is prose written for a browser: the ones in this repo run to six thousand
 * characters with a shell script embedded in each. Clamped in ONE place, so `--json` carries the
 * same bytes the terminal shows and `--full` moves both — a `lines` render that carried less than
 * the data would be two reports of one review.
 */
export function clampBody(
  body: string,
  limit: number,
): { readonly lines: readonly string[]; readonly hidden: number } {
  const lines = body.replaceAll('\r\n', '\n').split('\n');
  if (lines.length <= limit) return { lines, hidden: 0 };
  return { lines: lines.slice(0, limit), hidden: lines.length - limit };
}

function reviewJson(
  report: PrReviewReport,
  shown: readonly PrThread[],
  bodyLines: number,
  unresolved: number,
): JsonValue {
  const review = report.decidingReview;
  return {
    repo: report.repo,
    pr: report.number,
    url: report.url,
    headSha: report.headSha,
    headCommittedAt: report.headCommittedAt,
    reviewDecision: report.reviewDecision,
    review:
      review === null
        ? null
        : {
            state: review.state,
            author: review.author,
            submittedAt: review.submittedAt,
            commit: review.commit,
            // The hazard as a field, because an agent reading `--json` never sees the line above.
            stale: review.stale,
          },
    counts: {
      total: report.threads.length,
      unresolved,
      resolved: report.threads.length - unresolved,
      shown: shown.length,
    },
    truncated: report.truncated,
    threads: shown.map((thread) => {
      const comments = thread.comments.map((comment) => {
        const clamped = clampBody(comment.body, bodyLines);
        return {
          author: comment.author,
          createdAt: comment.createdAt,
          body: clamped.lines.join('\n'),
          bodyLinesHidden: clamped.hidden,
        };
      });
      return {
        id: thread.id,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        commentCount: thread.commentCount,
        comments,
      };
    }),
  };
}

/** A thread id is a positional: it comes out of `x pr review`, so it is never typed by hand. */
function threadIdOf(ctx: CommandContext, subcommand: string, example: string): string {
  const id = ctx.args.positionals[0];
  if (id === undefined) {
    throw new MissingPositionalError({
      command: `pr ${subcommand}`,
      positional: 'thread-id',
      example,
    });
  }
  return id;
}

/**
 * Resolving is a statement about the CONVERSATION. Nothing GitHub can be asked observes whether
 * the finding is fixed, so the summary says what happened and refuses to imply the other thing —
 * a command that reported "addressed" would be the framework asserting a fact it cannot check.
 */
async function runResolve(ctx: CommandContext): Promise<CommandResult> {
  const id = threadIdOf(ctx, 'resolve', 'x pr resolve PRRT_kwDOTkDHL86a6ivd --json');
  const resolved = await resolveThread(ctx, id);
  return {
    ok: true,
    command: 'pr',
    summary: msg('cli.pr.resolved', { id: resolved }),
    data: { threadId: resolved, isResolved: true },
  };
}

async function runReply(ctx: CommandContext): Promise<CommandResult> {
  const id = threadIdOf(
    ctx,
    'reply',
    'x pr reply PRRT_kwDOTkDHL86a6ivd --body "fixed in 0f3a91c" --json',
  );
  const body = flagString(ctx.args, 'body');
  if (body === undefined || body.trim() === '') {
    throw new BadFlagError({
      flag: 'body',
      command: 'pr reply',
      reason: 'a reply posts a comment, and an empty one says nothing to the reviewer',
      fix: 'x pr reply PRRT_kwDOTkDHL86a6ivd --body "fixed in 0f3a91c" --json',
    });
  }
  const url = await replyToThread(ctx, id, body);
  return {
    ok: true,
    command: 'pr',
    summary: msg('cli.pr.replied', { id, url }),
    data: { threadId: id, url },
  };
}
