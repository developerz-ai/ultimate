// File the night's flakes: one issue per failing test, found again by its stable title, so a test
// that fails every night collects comments on one issue instead of a pile of duplicates. A closed
// issue whose test failed again is reopened: a flake that recurs was not fixed.

import { isFixShellSafe } from '../packages/core/src/error-render';
import type { RoundDoc } from './flake-hunt-round';
import type { Filed, Gh, IssuePlan, Ledger } from './lib/issue-ledger';
import { fence, fileIssues as fileLedger, ledgerTitle } from './lib/issue-ledger';
import { gh as ghRun } from './lib/release-due-gh';

export type { Gh, IssuePlan } from './lib/issue-ledger';

/** The one label every flake-hunt issue carries — what `gh issue list --label` finds them by. */
export const LABEL = 'flake-hunt';
const EXCERPT_MAX = 4000;

const LEDGER: Ledger = {
  label: LABEL,
  color: 'fbca04',
  description: 'a test flake-hunt.yml saw fail under a shuffled order',
  code: 'X_FLAKE_HUNT_FILE_FAILED',
  fix: 'gh auth status && bun run scripts/flake-hunt.ts file <round.json…>',
  at: 'scripts/flake-hunt-file.ts',
};

const titleOf = (name: string): string => ledgerTitle(`flake: ${name}`);

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
      fence(
        'sh',
        // The path came off a test's output: pasted only when a shell reads it as one word
        // (`renderFixShellArg`'s rule; `./` keeps it a path to `bun test`, never a filter).
        `${env}bun test ${isFixShellSafe(first.file) ? `./${first.file}` : '<the failing test file>'} --randomize --seed=${first.round.seed}`,
      ),
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

/** One issue per plan, found again by title: the shared ledger, under the flake-hunt label. */
export const fileIssues = (
  plans: readonly IssuePlan[],
  root: string,
  gh: Gh = ghRun,
): Promise<Filed> => fileLedger(plans, root, LEDGER, gh);
