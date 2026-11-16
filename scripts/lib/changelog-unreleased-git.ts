// The reads behind `changelog-unreleased.ts`: the diff since `origin/main` (`changed-files.ts`),
// CHANGELOG.md at that base and on disk, and the pull request's labels from `GITHUB_EVENT_PATH`.
// A pull request in CI (`GITHUB_BASE_REF` set, as `contract-diff` reads it) is refused on a gap;
// anywhere else the gap is reported and never blocks.

import type { GitRunner } from './base-ref';
import { textAt } from './base-ref';
import { changedSinceBase } from './changed-files';
import { CHANGELOG_PATH } from './changelog-format';
import { eventLabels, unreleasedGap } from './changelog-unreleased';
import type { Finding } from './log';
import { run } from './run';

type Env = Readonly<Record<string, string | undefined>>;

export interface UnreleasedCheck {
  readonly finding: Finding | undefined;
  /** A pull request in CI: the finding fails the gate. Locally it is a notice. */
  readonly blocking: boolean;
}

/** Whether this run judges a pull request: `GITHUB_BASE_REF` is set on exactly those runs. */
export const judgesPullRequest = (env: Env): boolean => (env['GITHUB_BASE_REF'] ?? '') !== '';

/** The labels on the event this run was started by; none when there is no payload to read. */
export async function runLabels(env: Env): Promise<readonly string[]> {
  const path = env['GITHUB_EVENT_PATH'];
  if (path === undefined || path === '') return [];
  try {
    return eventLabels(JSON.parse(await Bun.file(path).text()));
  } catch {
    // A payload that cannot be read carries no opt-out: the rule then asks for the line.
    return [];
  }
}

export async function unreleasedCheck(
  root: string,
  env: Env,
  runner: GitRunner = run,
): Promise<UnreleasedCheck> {
  const diff = await changedSinceBase(root, runner);
  const baseIndex =
    diff.base === undefined ? '' : ((await textAt(root, diff.base, CHANGELOG_PATH, runner)) ?? '');
  const headIndex = await Bun.file(`${root}/${CHANGELOG_PATH}`)
    .text()
    .catch(() => '');
  const finding = unreleasedGap({
    changed: diff.base === undefined ? undefined : diff.changed,
    added: diff.added,
    baseIndex,
    headIndex,
    labels: await runLabels(env),
  });
  return { finding, blocking: judgesPullRequest(env) };
}
