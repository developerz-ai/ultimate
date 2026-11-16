// One GitHub issue per stable title, under one label, filed over an injected `gh`: an unknown title
// is created, an open one commented on, a closed one reopened — and, for a watcher whose subject
// can go green again, an open one whose subject passed is closed. Shared by the flake hunt and the
// compat matrix, so a title found again behaves the same for both.

import { jsonDocument } from './health-narrow';
import type { Finding } from './log';
import { gh as ghRun } from './release-due-gh';
import type { RunResult } from './run';

export interface IssuePlan {
  readonly title: string;
  readonly body: string;
}

export type Gh = (args: readonly string[], cwd: string) => Promise<RunResult>;

/** Whose issues these are: the label that finds them, and what a refused `gh` call reports. */
export interface Ledger {
  readonly label: string;
  readonly color: string;
  readonly description: string;
  /** The finding's code when `gh` refuses a call. */
  readonly code: string;
  /** The finding's `fix:` — a command, pasted as is. */
  readonly fix: string;
  /** The finding's `at:` — the file that files. */
  readonly at: string;
}

export interface Filed {
  readonly filed: readonly string[];
  readonly findings: readonly Finding[];
}

/** GitHub refuses a title past 256 characters; cut short of it, the same way every run. */
const TITLE_MAX = 240;

/** `title` as the ledger stores it: cut at the same length every time, so it is found again. */
export const ledgerTitle = (title: string): string =>
  title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;

/**
 * A code fence no line of `text` can close: one backtick longer than the longest run it holds,
 * three at least. A fixed four broke on output carrying four, and the rest of the excerpt was
 * Markdown — where an `@scope/x` in a stack trace notifies a real account.
 */
export const fence = (lang: string, text: string): string => {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const failed = (ledger: Ledger, what: string, result: RunResult): Finding => ({
  code: ledger.code,
  cause: `gh could not ${what}: ${result.output.trim().slice(0, 500) || `exit ${result.code}`}`,
  fix: ledger.fix,
  at: ledger.at,
});

interface Known {
  readonly number: number;
  readonly open: boolean;
}

/** Every issue by title, the open one preferred; undefined when gh answered no list. */
const knownIssues = (output: string): Map<string, Known> | undefined => {
  const doc = jsonDocument(output);
  if (!Array.isArray(doc)) return undefined;
  const known = new Map<string, Known>();
  for (const one of doc as unknown[]) {
    const row = one !== null && typeof one === 'object' ? (one as Record<string, unknown>) : {};
    const [title, number] = [row['title'], row['number']];
    if (typeof title !== 'string' || typeof number !== 'number') continue;
    const open = row['state'] === 'OPEN';
    const seen = known.get(title);
    if (seen === undefined || (open && !seen.open)) known.set(title, { number, open });
  }
  return known;
};

/** The label, created first so a repeat and a race both pass; refused only when it is not there. */
const ensureLabel = async (ledger: Ledger, root: string, gh: Gh): Promise<Finding | undefined> => {
  const label = await gh(
    ['label', 'create', ledger.label, '--color', ledger.color, '--description', ledger.description],
    root,
  );
  if (label.ok) return undefined;
  const exists = await gh(['api', `repos/{owner}/{repo}/labels/${ledger.label}`], root);
  return exists.ok ? undefined : failed(ledger, `create the ${ledger.label} label`, label);
};

const actionFor = (
  plan: IssuePlan,
  label: string,
  issue: Known | undefined,
): readonly [readonly string[], string] => {
  if (issue === undefined) {
    return [
      ['issue', 'create', '--label', label, '--title', plan.title, '--body', plan.body],
      `created: ${plan.title}`,
    ];
  }
  return issue.open
    ? [
        ['issue', 'comment', String(issue.number), '--body', plan.body],
        `commented #${issue.number}: ${plan.title}`,
      ]
    : [
        ['issue', 'reopen', String(issue.number), '--comment', plan.body],
        `reopened #${issue.number}: ${plan.title}`,
      ];
};

/**
 * File every plan, and close the open issue of every `resolved` title with its body as the closing
 * comment. Nothing to do asks gh nothing; a resolved title with no open issue is left alone. A
 * refused call is a finding, and the other plans are still filed.
 */
export async function fileIssues(
  plans: readonly IssuePlan[],
  root: string,
  ledger: Ledger,
  gh: Gh = ghRun,
  resolved: readonly IssuePlan[] = [],
): Promise<Filed> {
  if (plans.length === 0 && resolved.length === 0) return { filed: [], findings: [] };
  if (plans.length > 0) {
    const refused = await ensureLabel(ledger, root, gh);
    if (refused !== undefined) return { filed: [], findings: [refused] };
  }
  const fields = 'number,title,state';
  const listed = await gh(
    [
      'issue',
      'list',
      '--label',
      ledger.label,
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      fields,
    ],
    root,
  );
  const known = listed.ok ? knownIssues(listed.output) : undefined;
  if (known === undefined) {
    return { filed: [], findings: [failed(ledger, `list the ${ledger.label} issues`, listed)] };
  }
  const steps: (readonly [readonly string[], string, string])[] = plans.map((plan) => [
    ...actionFor(plan, ledger.label, known.get(plan.title)),
    plan.title,
  ]);
  for (const plan of resolved) {
    const issue = known.get(plan.title);
    if (issue === undefined || !issue.open) continue;
    const args = ['issue', 'close', String(issue.number), '--comment', plan.body];
    steps.push([args, `closed #${issue.number}: ${plan.title}`, plan.title]);
  }
  const filed: string[] = [];
  const findings: Finding[] = [];
  for (const [args, done, title] of steps) {
    const result = await gh(args, root);
    if (result.ok) filed.push(done);
    else findings.push(failed(ledger, `file "${title}"`, result));
  }
  return { filed, findings };
}
