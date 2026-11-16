// The stale-bot-issues row: an open issue the automation filed whose condition is no longer true —
// its own closer workflow ran green after the issue last re-fired, so the close step that should
// have shut it did not. Each bot label maps to its closer here; an unmapped label is no verdict
// that names this table, so a new alarm cannot slip past the row unread.

import { jsonDocument } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';

/**
 * Every label the automation files under, and the workflow whose green run proves its condition
 * gone. `null` is a label a person closes: a flake-hunt issue names a flake, and a green night is
 * not its fix. `compat` is compat.yml's per-cell issue, closed by its own green run.
 */
export const BOT_ALARMS: Readonly<Record<string, string | null>> = {
  'registry-drift': 'registry-audit.yml',
  compat: 'compat.yml',
  'flake-hunt': null,
};

const LIMIT = 100;
const ISSUE_ARGS = [
  'issue',
  'list',
  '--state',
  'open',
  '--search',
  'author:app/github-actions',
  '--limit',
  String(LIMIT),
  '--json',
  'number,title,labels,updatedAt,url',
] as const;
const CLOSERS = [...new Set(Object.values(BOT_ALARMS).filter((one) => one !== null))];
const runArgs = (workflow: string): readonly string[] => [
  ...['run', 'list', '--workflow', workflow, '--status', 'success'],
  ...['--limit', '1', '--json', 'createdAt,url'],
];

// Exported for the brief's test and the reader's: a re-run is the same queries, in this order.
export const BOT_ISSUES_COMMAND = [ISSUE_ARGS, ...CLOSERS.map(runArgs)]
  .map((args) => `gh ${args.join(' ')}`)
  .join('; ');

export interface BotIssuesRead {
  readonly issues: unknown;
  /** Each closer's newest green run list; `[]` for a workflow not on the default branch yet. */
  readonly greens: Readonly<Record<string, unknown>>;
}

type Gh = (args: readonly string[], cwd: string) => Promise<RunResult>;

export const botIssuesReader = async (root: string, ghRunner: Gh): Promise<BotIssuesRead> => {
  const issues = jsonDocument((await ghRunner(ISSUE_ARGS, root)).output);
  const greens: Record<string, unknown> = {};
  for (const workflow of CLOSERS) {
    const answer = await ghRunner(runArgs(workflow), root);
    const absent = !answer.ok && /HTTP 404: workflow .* not found/.test(answer.output);
    greens[workflow] = absent ? [] : jsonDocument(answer.output);
  }
  return { issues, greens };
};

interface BotIssue {
  readonly number: number;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly labels: readonly string[];
}

const rec = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const narrow = (value: unknown): readonly BotIssue[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const read = value.flatMap((one: unknown): BotIssue[] => {
    const issue = rec(one);
    const number = issue?.['number'];
    if (issue === undefined || typeof number !== 'number') return [];
    const labels = Array.isArray(issue['labels']) ? issue['labels'] : [];
    return [
      {
        number,
        title: text(issue['title']),
        url: text(issue['url']),
        updatedAt: text(issue['updatedAt']),
        labels: labels.flatMap((label: unknown) => text(rec(label)?.['name']) ?? []),
      },
    ];
  });
  return read.length === value.length ? read : undefined;
};

/** The newest green run's creation time, `-Infinity` for none; undefined for an unread list. */
const greenAt = (value: unknown): number | undefined => {
  if (!Array.isArray(value)) return undefined;
  const at = Date.parse(text(rec(value[0])?.['createdAt']) ?? '');
  return value.length === 0 ? Number.NEGATIVE_INFINITY : Number.isFinite(at) ? at : undefined;
};

export const judgeBotIssues = (read: BotIssuesRead): RowVerdict | Finding => {
  const base = { row: 'stale-bot-issues' as const };
  const issues = narrow(read.issues);
  const greens = new Map(CLOSERS.map((workflow) => [workflow, greenAt(read.greens[workflow])]));
  if (issues === undefined || [...greens.values()].includes(undefined)) {
    return {
      code: 'X_HEALTH_ROW_UNREADABLE',
      cause: `the stale-bot-issues row could not be read: ${BOT_ISSUES_COMMAND} — gh printed no JSON issue or run list`,
      fix: 'bun run scripts/health.ts --json',
      at: 'scripts/health.ts',
    };
  }
  if (issues.length >= LIMIT) {
    const reason = `the page came back full (${LIMIT}): older bot issues are unread — raise --limit`;
    return { ...base, verdict: 'unverdicted', reason };
  }
  const unmapped = issues.filter((one) => !one.labels.some((label) => label in BOT_ALARMS));
  const stale = issues.filter((one) =>
    one.labels.some((label) => {
      const closer = BOT_ALARMS[label];
      const green = closer === null || closer === undefined ? undefined : greens.get(closer);
      return green !== undefined && green > Date.parse(one.updatedAt ?? '');
    }),
  );
  const listed = (some: readonly BotIssue[]) => some.map(({ labels: _, ...one }) => one);
  if (stale.length > 0) {
    return {
      ...base,
      verdict: 'unhealthy',
      reason: `${stale.length} bot issue(s) outlived their condition — the closer ran green after the last re-fire: ${stale.map((one) => `#${one.number}`).join(', ')}`,
      fix: stale.map((one) => `gh issue close ${one.number} --reason completed`).join(' && '),
      issues: listed(stale),
    };
  }
  if (unmapped.length > 0) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason: `bot issue(s) under a label with no known closer: ${unmapped.map((one) => `#${one.number}`).join(', ')} — map the label in BOT_ALARMS (scripts/lib/health-bot-issues.ts)`,
      issues: listed(unmapped),
    };
  }
  return {
    ...base,
    verdict: 'healthy',
    reason: 'every open bot issue still names a live condition',
  };
};
