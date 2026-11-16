// The finished row "the loop is closed": the newest release bump PR was opened by the maintainer
// bot, and the newest red push to main was repaired by a PR the bot opened — no person on either
// path. Read through an injected `gh`; an answer it cannot give is `unverdicted`, never green.

import type { FinishedRow, Runner } from './finished-rule';
import { green, isRecord, parsedOutput, red, stringField, unverdicted } from './finished-rule';
import type { Finding } from './lib/log';

/** The developerz.ai maintainer (`.dz/maintainer/maintainer.yml`), as `gh pr --json author` names it. */
export const MAINTAINER_LOGIN = 'app/developerz-ai';
/** How many completed pushes to main are searched for the newest red one. */
export const RED_DEPTH = 50;

const RELEASE_PR = [
  'pr',
  'list',
  '--state',
  'merged',
  '--search',
  'chore: release in:title',
  '--limit',
  '1',
  '--json',
  'number,author,url',
];
const MAIN_RUNS = [
  'run',
  'list',
  '--workflow',
  'ci.yml',
  '--branch',
  'main',
  '--event',
  'push',
  '--status',
  'completed',
  '--limit',
  String(RED_DEPTH),
  '--json',
  'conclusion,headSha,url',
];
const prBySha = (sha: string): readonly string[] => [
  'pr',
  'list',
  '--state',
  'merged',
  '--search',
  sha,
  '--limit',
  '1',
  '--json',
  'number,author,url',
];

export const LOOP_COMMAND = `gh ${RELEASE_PR.join(' ')}; gh ${MAIN_RUNS.join(' ')}; gh pr list --state merged --search <sha> --json number,author,url`;

/** The first PR of a `gh pr list` page: its author's login and url, or `undefined` unread. */
const firstPr = (doc: unknown): { login: string; url: string } | undefined => {
  if (!Array.isArray(doc)) return undefined;
  const pr: unknown = doc[0];
  const login = stringField(isRecord(pr) ? pr['author'] : undefined, 'login');
  return login === undefined ? undefined : { login, url: stringField(pr, 'url') ?? '' };
};

const handed = (cause: string): Finding => ({
  code: 'X_FINISHED_LOOP_OPEN',
  cause,
  fix: 'cat .dz/maintainer/maintainer.yml   # the maintainer cuts releases (.dz/briefs/release-due.md) and repairs main (docs/ops/maintainer-runbooks/main-red.md); leave the next one to it',
  at: '.dz/maintainer/maintainer.yml',
});

export async function loopRow(root: string, gh: Runner): Promise<FinishedRow> {
  const release = parsedOutput(await gh(RELEASE_PR, root));
  const runs = parsedOutput(await gh(MAIN_RUNS, root));
  if (!Array.isArray(release) || !Array.isArray(runs)) {
    return unverdicted('loop-closed', LOOP_COMMAND, 'no PR list or no run list');
  }
  const findings: Finding[] = [];
  const cut = firstPr(release);
  if (cut === undefined) findings.push(handed('no merged release PR exists to read who cut it'));
  else if (cut.login !== MAINTAINER_LOGIN) {
    findings.push(
      handed(`the newest release (${cut.url}) was opened by ${cut.login}, not ${MAINTAINER_LOGIN}`),
    );
  }
  const conclusions = runs.map((run) => stringField(run, 'conclusion'));
  const redAt = conclusions.findIndex((one) => one === 'failure' || one === 'timed_out');
  let repair = `no red push to main in the last ${RED_DEPTH}`;
  if (redAt !== -1) {
    const fixedAt = conclusions.slice(0, redAt).lastIndexOf('success');
    const redUrl = stringField(runs[redAt], 'url') ?? '';
    const sha = fixedAt === -1 ? undefined : stringField(runs[fixedAt], 'headSha');
    if (sha === undefined) {
      findings.push(handed(`main is red since ${redUrl} and no push has repaired it yet`));
    } else {
      const pr = firstPr(parsedOutput(await gh(prBySha(sha), root)));
      if (pr === undefined) return unverdicted('loop-closed', LOOP_COMMAND, `no PR for ${sha}`);
      repair = `the newest main-red (${redUrl}) was repaired by ${pr.login} (${pr.url})`;
      if (pr.login !== MAINTAINER_LOGIN) {
        findings.push(
          handed(
            `the newest main-red (${redUrl}) was repaired by ${pr.login} (${pr.url}), not ${MAINTAINER_LOGIN}`,
          ),
        );
      }
    }
  }
  return findings.length === 0
    ? green('loop-closed', `the newest release was cut by ${MAINTAINER_LOGIN}; ${repair}`)
    : red('loop-closed', findings.map((one) => one.cause).join('; '), findings);
}
