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
 * The notices, known by their MARKERS and never by a phrase in prose: a review that discusses
 * "rate limit exceeded" in an upstream API is a review, not a bot refusing to give one.
 * CodeRabbit's own HTML comment tags come first; otherwise the notice is a markdown heading
 * (quoted or not) that BEGINS with the notice's title.
 */
const MARKERS: readonly { readonly kind: BotNoticeKind; readonly pattern: RegExp }[] = [
  { kind: 'rate-limited', pattern: /<!--[^>]*rate limited by coderabbit\.ai[^>]*-->/i },
  { kind: 'skipped', pattern: /<!--[^>]*skip review by coderabbit\.ai[^>]*-->/i },
];
const HEADINGS: readonly { readonly kind: BotNoticeKind; readonly pattern: RegExp }[] = [
  { kind: 'rate-limited', pattern: /^(?:rate limit exceeded|review limit reached)\b/i },
  { kind: 'skipped', pattern: /^review skipped\b/i },
];

/** A markdown heading line, quoted or not, as its title text; `undefined` for any other line. */
const headingOf = (line: string): string | undefined => {
  const match = /^[>\s]*#{1,6}\s+(.+)$/.exec(line);
  return match?.[1]?.replaceAll('*', '').trim();
};

/**
 * The notice an ISSUE COMMENT states, or `null` for every ordinary body. A formal review is never
 * passed here: whatever its body says, a submitted review is the bot having reviewed.
 */
export function botNotice(body: string): BotNotice | null {
  const headings = body
    .replaceAll('\r\n', '\n')
    .split('\n')
    .flatMap((line) => {
      const title = headingOf(line);
      return title === undefined ? [] : [title];
    });
  for (const title of headings) {
    const rule = HEADINGS.find((candidate) => candidate.pattern.test(title));
    if (rule !== undefined) return { kind: rule.kind, excerpt: title.slice(0, 200) };
  }
  const marker = MARKERS.find((candidate) => candidate.pattern.test(body));
  if (marker === undefined) return null;
  return { kind: marker.kind, excerpt: (headings[0] ?? '').slice(0, 200) };
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
    // Issue comments only: a submitted review is the bot having reviewed, whatever it says.
    const spoken: readonly Spoken[] = said.map((comment) => ({
      at: comment.updatedAt,
      url: comment.url,
      notice: botNotice(comment.body),
    }));
    const lastReview = newest(own.map((review) => ({ at: review.submittedAt ?? '' })));
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
