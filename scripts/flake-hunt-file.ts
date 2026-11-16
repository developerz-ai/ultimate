// File the night's flakes: one issue per failing test, found again by its stable title, so a test
// that fails every night collects comments on one issue instead of a pile of duplicates. A closed
// issue whose test failed again is reopened: a flake that recurs was not fixed.

import type { RoundDoc } from './flake-hunt-round';
import { jsonDocument } from './lib/health-narrow';
import type { Finding } from './lib/log';
import { gh as ghRun } from './lib/release-due-gh';
import type { RunResult } from './lib/run';

/** The one label every flake-hunt issue carries — what `gh issue list --label` finds them by. */
export const LABEL = 'flake-hunt';
/** GitHub refuses a title past 256 characters; cut short of it, the same way every night. */
const TITLE_MAX = 240;
const EXCERPT_MAX = 4000;

export interface IssuePlan {
  readonly title: string;
  readonly body: string;
}

export type Gh = (args: readonly string[], cwd: string) => Promise<RunResult>;

const titleOf = (name: string): string => {
  const title = `flake: ${name}`;
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
};

const fence = (lang: string, text: string): string => `\`\`\`\`${lang}\n${text}\n\`\`\`\``;

const bodyOf = (
  hits: readonly { readonly round: RoundDoc; readonly file?: string; readonly excerpt: string }[],
  runUrl: string | undefined,
): string => {
  const [first] = hits;
  const lines = [
    `\`flake-hunt\` saw this fail${runUrl === undefined ? '' : ` in ${runUrl}`}.`,
    '',
    '| suite | round | seed |',
    '|---|---|---|',
    ...hits.map(({ round }) => `| ${round.suite} | ${round.round} | ${round.seed} |`),
    '',
    'Replay each round in its order:',
    fence('sh', [...new Set(hits.map(({ round }) => round.rerun))].join('\n')),
  ];
  if (first?.file !== undefined) {
    const env = first.round.suite === 'live' ? 'set -a; . docker/test-services.env; set +a; ' : '';
    lines.push(
      '',
      'The file alone, same seed — order across files is lost, so green here is not a fix:',
    );
    lines.push(
      fence('sh', `${env}bun test ./${first.file} --randomize --seed=${first.round.seed}`),
    );
  }
  lines.push('', 'What Bun printed:', fence('text', (first?.excerpt ?? '').slice(-EXCERPT_MAX)));
  return lines.join('\n');
};

/** The issues a night's rounds call for, one per failing test, in first-seen order. */
export function issuesFor(rounds: readonly RoundDoc[], runUrl: string | undefined): IssuePlan[] {
  type Hit = { readonly round: RoundDoc; readonly file?: string; readonly excerpt: string };
  const byTitle = new Map<string, Hit[]>();
  const add = (title: string, hit: Hit): void => {
    byTitle.set(title, [...(byTitle.get(title) ?? []), hit]);
  };
  for (const round of rounds) {
    for (const failure of round.failures) {
      add(titleOf(`${failure.file} > ${failure.test}`), { round, ...failure });
    }
    if (!round.ok && round.failures.length === 0) {
      add(titleOf(`${round.suite} run red with no failing test named`), {
        round,
        excerpt: [...round.findings.map((one) => `${one.code}: ${one.cause}`), round.tail].join(
          '\n',
        ),
      });
    }
  }
  return [...byTitle].map(([title, hits]) => ({ title, body: bodyOf(hits, runUrl) }));
}

const failed = (what: string, result: RunResult): Finding => ({
  code: 'X_FLAKE_HUNT_FILE_FAILED',
  cause: `gh could not ${what}: ${result.output.trim().slice(0, 500) || `exit ${result.code}`}`,
  fix: 'gh auth status && bun run scripts/flake-hunt.ts file <round.json…>',
  at: 'scripts/flake-hunt-file.ts',
});

interface Known {
  readonly number: number;
  readonly open: boolean;
}

/** Every flake-hunt issue by title, the open one preferred; undefined when gh answered no list. */
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

export async function fileIssues(
  plans: readonly IssuePlan[],
  root: string,
  gh: Gh = ghRun,
): Promise<{ readonly filed: readonly string[]; readonly findings: readonly Finding[] }> {
  // A green night touches nothing: no label, no list, no API call to fail on.
  if (plans.length === 0) return { filed: [], findings: [] };
  const description = 'a test flake-hunt.yml saw fail under a shuffled order';
  const label = await gh(
    ['label', 'create', LABEL, '--color', 'fbca04', '--description', description],
    root,
  );
  // Create-first, so the nightly repeat and a race both pass: a refusal is fatal only when the
  // label's own endpoint cannot confirm it exists.
  if (!label.ok) {
    const exists = await gh(['api', `repos/{owner}/{repo}/labels/${LABEL}`], root);
    if (!exists.ok) return { filed: [], findings: [failed(`create the ${LABEL} label`, label)] };
  }
  const listed = await gh(
    [
      'issue',
      'list',
      '--label',
      LABEL,
      '--state',
      'all',
      '--limit',
      '1000',
      '--json',
      'number,title,state',
    ],
    root,
  );
  const known = listed.ok ? knownIssues(listed.output) : undefined;
  if (known === undefined)
    return { filed: [], findings: [failed('list the flake-hunt issues', listed)] };
  const filed: string[] = [];
  const findings: Finding[] = [];
  for (const plan of plans) {
    const issue = known.get(plan.title);
    const [args, done] =
      issue === undefined
        ? [
            ['issue', 'create', '--label', LABEL, '--title', plan.title, '--body', plan.body],
            `created: ${plan.title}`,
          ]
        : issue.open
          ? [
              ['issue', 'comment', String(issue.number), '--body', plan.body],
              `commented #${issue.number}: ${plan.title}`,
            ]
          : [
              ['issue', 'reopen', String(issue.number), '--comment', plan.body],
              `reopened #${issue.number}: ${plan.title}`,
            ];
    const result = await gh(args, root);
    if (result.ok) filed.push(done);
    else findings.push(failed(`file "${plan.title}"`, result));
  }
  return { filed, findings };
}
