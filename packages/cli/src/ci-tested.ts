// `x ci tested`'s predicate: was THIS push's tree already proved green by the pull request run that
// merged it? Pure over three injected GitHub reads, so every condition is a unit test; `ghTestedReads`
// is the one `gh api` binding. Any doubt answers `tested: false`, which runs everything.

import { renderFixShellArg, renderThrowable } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { GhHost } from './gh';
import { GhFailedError, ghJson } from './gh';
import type { GhRepo } from './gh-target';

/** Why the answer is what it is: `tested` when every condition held, else the first that did not. */
export const TESTED_CONDITIONS = [
  'tested',
  'subject',
  'merged',
  'fork',
  'tree',
  'run',
  'stale',
  'api',
  // No commit to ask about: no `GITHUB_SHA`, and `git rev-parse HEAD` named none.
  'sha',
] as const;

export type TestedCondition = (typeof TESTED_CONDITIONS)[number];

export interface TestedCommit {
  /** The whole message's first line. */
  readonly subject: string;
  readonly tree: string;
}

export interface TestedPull {
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
  readonly headSha: string;
  /** `owner/name` of the head's repository; `null` when that repository is gone. */
  readonly headRepo: string | null;
}

export interface TestedRun {
  readonly id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly headRepo: string | null;
  /** When the run last changed, which for a completed run is when it concluded. */
  readonly completedAt: string;
}

/** The three questions the predicate asks GitHub, injected. */
export interface CiTestedReads {
  readonly commit: (sha: string) => Promise<TestedCommit>;
  readonly pull: (number: number) => Promise<TestedPull>;
  /** The workflow's runs on one head commit, any event. */
  readonly runs: (headSha: string) => Promise<readonly TestedRun[]>;
}

export interface CiTestedAnswer {
  readonly tested: boolean;
  readonly condition: TestedCondition;
  readonly pr?: number;
  readonly run?: number;
  /** Only for `api`: the refusal, rendered. */
  readonly detail?: string;
}

/**
 * `(#N)` as the subject's LAST characters, which is how GitHub's squash and merge-commit subjects
 * end. Mid-subject, or on a body line, it is a reference to a PR, never the PR that merged it.
 */
export function mergedPullOf(subject: string): number | undefined {
  const match = /\(#(\d+)\)$/.exec(subject);
  return match === null || subject.includes('\n') ? undefined : Number(match[1]);
}

export async function ciTested(input: {
  readonly sha: string;
  readonly repo: string;
  readonly maxAgeMs: number;
  readonly now: number;
  readonly reads: CiTestedReads;
}): Promise<CiTestedAnswer> {
  const { sha, repo, reads } = input;
  let pr: number | undefined;
  try {
    const pushed = await reads.commit(sha);
    pr = mergedPullOf(pushed.subject);
    if (pr === undefined) return { tested: false, condition: 'subject' };
    const pull = await reads.pull(pr);
    if (!pull.merged || pull.mergeCommitSha !== sha)
      return { tested: false, condition: 'merged', pr };
    // A fork's workflow file is the fork's to write: its green says nothing this repository trusts.
    if (pull.headRepo !== repo) return { tested: false, condition: 'fork', pr };
    const head = await reads.commit(pull.headSha);
    if (head.tree !== pushed.tree) return { tested: false, condition: 'tree', pr };
    const own = (await reads.runs(pull.headSha)).filter((run) => run.headRepo === repo);
    // The newest run decides: a red run after a green one on the same head is the later verdict.
    const newest = [...own].sort((a, b) => b.id - a.id)[0];
    if (newest === undefined) return { tested: false, condition: 'run', pr };
    if (newest.status !== 'completed' || newest.conclusion !== 'success') {
      return { tested: false, condition: 'run', pr, run: newest.id };
    }
    const age = input.now - Date.parse(newest.completedAt);
    if (!(age >= 0 && age <= input.maxAgeMs)) {
      return { tested: false, condition: 'stale', pr, run: newest.id };
    }
    return { tested: true, condition: 'tested', pr, run: newest.id };
  } catch (error) {
    // Any read that did not answer widens the gate: a full run costs minutes, a wrong skip ships.
    return {
      tested: false,
      condition: 'api',
      ...(pr === undefined ? {} : { pr }),
      detail: renderThrowable(error),
    };
  }
}

const COMMIT = t.object({ subject: t.string, tree: t.string });
const PULL = t.object({
  merged: t.boolean,
  mergeCommitSha: t.nullable(t.string),
  headSha: t.string,
  headRepo: t.nullable(t.string),
});
const RUNS = t.array(
  t.object({
    id: t.number,
    status: t.string,
    conclusion: t.nullable(t.string),
    headRepo: t.nullable(t.string),
    completedAt: t.string,
  }),
);

/** One `gh` call's deadline: four calls stay well inside the `tested` job's five minutes. */
export const TESTED_CALL_TIMEOUT_MS = 30_000;

const killHard = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone between the deadline and the signal.
  }
};

/**
 * `host`, with every call killed past `ms`: a stalled `gh api` must answer `tested: false` (the
 * caller's `api` doubt), never hold the job until its `timeout-minutes` turns it red. The refusal
 * is `X_GH_COMMAND_FAILED` — a call that did not answer is one more non-zero `gh`.
 */
export function withDeadline(
  host: GhHost,
  ms: number,
  kill: (pid: number) => void = killHard,
): GhHost {
  return {
    cwd: host.cwd,
    runner: (command, options) =>
      new Promise((resolve, reject) => {
        let pid: number | undefined;
        const timer = setTimeout(() => {
          if (pid !== undefined) kill(pid);
          reject(
            new GhFailedError({
              label: command.slice(0, 3).join(' '),
              code: -1,
              detail: `did not answer within ${ms} ms and was killed`,
              fix: 'x ci tested --json',
            }),
          );
        }, ms);
        host
          .runner(command, {
            ...options,
            onSpawn: (spawned) => {
              pid = spawned;
              options.onSpawn?.(spawned);
            },
          })
          .then(
            (result) => {
              clearTimeout(timer);
              resolve(result);
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error);
            },
          );
      }),
  };
}

/** The reads, through `gh api`: `--jq` projects each answer to exactly the fields above. */
export function ghTestedReads(host: GhHost, repo: GhRepo, workflow: string): CiTestedReads {
  const api = `repos/${repo.slug}`;
  const fix = `x ci tested --repo ${renderFixShellArg(repo.slug, '<owner/name>')} --json`;
  return {
    commit: (sha) =>
      ghJson(
        host,
        [
          'api',
          `${api}/commits/${sha}`,
          '--jq',
          '{subject: (.commit.message | split("\\n")[0]), tree: .commit.tree.sha}',
        ],
        COMMIT,
        { label: `gh api commits/${sha}`, fix },
      ),
    pull: (number) =>
      ghJson(
        host,
        [
          'api',
          `${api}/pulls/${number}`,
          '--jq',
          '{merged, mergeCommitSha: .merge_commit_sha, headSha: .head.sha, headRepo: .head.repo.full_name}',
        ],
        PULL,
        { label: `gh api pulls/${number}`, fix },
      ),
    runs: (headSha) =>
      ghJson(
        host,
        [
          'api',
          '-X',
          'GET',
          `${api}/actions/workflows/${workflow}/runs`,
          '-f',
          `head_sha=${headSha}`,
          '-f',
          'per_page=50',
          '--jq',
          '[.workflow_runs[] | {id, status, conclusion, headRepo: .head_repository.full_name, completedAt: .updated_at}]',
        ],
        RUNS,
        { label: `gh api ${workflow} runs`, fix },
      ),
  };
}
