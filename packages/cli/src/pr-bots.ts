// Which review bots spoke on a pull request, and whether one of them said it did NOT review it. A
// rate-limited or skipped bot leaves no thread and no verdict, so its silence reads exactly like a
// clean review unless something reads the notice it posted instead.

import type { PrIssueComment, PrReviewEntry } from './pr-activity';

export type BotNoticeKind = 'rate-limited' | 'skipped';

export interface BotNotice {
  readonly kind: BotNoticeKind;
  /** The notice's own heading or first line, so a reader sees which notice without the body. */
  readonly excerpt: string;
}

export interface BotSummary {
  readonly login: string;
  readonly reviews: number;
  readonly comments: number;
  /** The bot's newest review that is not itself a notice; `null` when it never reviewed. */
  readonly lastReviewAt: string | null;
  /** The newest "did not review" notice it posted, wherever it posted it. */
  readonly notice: (BotNotice & { readonly at: string; readonly url: string }) | null;
  /** A notice exists and no review of the bot's came after it: its review is missing, not clean. */
  readonly blocked: boolean;
}

/**
 * The notices known by their wording, in the order they are tried. CodeRabbit's own HTML markers
 * (`rate limited by coderabbit.ai`, `skip review by coderabbit.ai`) come first; the prose rules
 * catch the same notice from a bot that words it the usual way.
 */
const NOTICES: readonly { readonly kind: BotNoticeKind; readonly pattern: RegExp }[] = [
  { kind: 'rate-limited', pattern: /rate limited by coderabbit\.ai/i },
  { kind: 'skipped', pattern: /skip review by coderabbit\.ai/i },
  { kind: 'rate-limited', pattern: /rate limit exceeded|review limit|exceeded the limit for/i },
  { kind: 'skipped', pattern: /review skipped|too many files|max files limit/i },
];

/** A line that is a heading, a quote or an admonition, read as the words it carries. */
const plain = (line: string): string =>
  line
    .replace(/^[>\s]*/, '')
    .replace(/^#+\s*/, '')
    .trim();

const isProse = (line: string): boolean =>
  line !== '' && !line.startsWith('<!--') && !/^\[![A-Z]+\]$/.test(line);

/** The notice a body states, or `null` for every body that is an ordinary review or comment. */
export function botNotice(body: string): BotNotice | null {
  const rule = NOTICES.find((candidate) => candidate.pattern.test(body));
  if (rule === undefined) return null;
  const lines = body.replaceAll('\r\n', '\n').split('\n').map(plain).filter(isProse);
  const excerpt = (lines.find((line) => /limit|skipped|too many/i.test(line)) ?? lines[0] ?? '')
    .replaceAll('*', '')
    .slice(0, 200);
  return { kind: rule.kind, excerpt };
}

interface Spoken {
  readonly at: string;
  readonly url: string;
  readonly notice: BotNotice | null;
}

const newest = <T extends { readonly at: string }>(rows: readonly T[]): T | null =>
  rows.reduce<T | null>((best, row) => (best === null || row.at > best.at ? row : best), null);

/** One row per bot that reviewed or commented, in the order each first appears. */
export function botsSummary(
  reviews: readonly PrReviewEntry[],
  comments: readonly PrIssueComment[],
): readonly BotSummary[] {
  const logins: string[] = [];
  for (const row of [...reviews, ...comments]) {
    if (row.isBot && !logins.includes(row.author)) logins.push(row.author);
  }
  return logins.map((login) => {
    const own = reviews.filter((review) => review.isBot && review.author === login);
    const said = comments.filter((comment) => comment.isBot && comment.author === login);
    const spoken: readonly Spoken[] = [
      ...own.map((review) => ({
        at: review.submittedAt ?? '',
        url: review.url,
        notice: botNotice(review.body),
      })),
      ...said.map((comment) => ({
        at: comment.updatedAt,
        url: comment.url,
        notice: botNotice(comment.body),
      })),
    ];
    const lastReview = newest(
      own
        .filter((review) => botNotice(review.body) === null)
        .map((r) => ({ at: r.submittedAt ?? '' })),
    );
    const latest = newest(spoken.filter((entry) => entry.notice !== null));
    const notice =
      latest?.notice == null ? null : { ...latest.notice, at: latest.at, url: latest.url };
    return {
      login,
      reviews: own.length,
      comments: said.length,
      lastReviewAt: lastReview?.at ?? null,
      notice,
      blocked: notice !== null && (lastReview === null || lastReview.at <= notice.at),
    };
  });
}
