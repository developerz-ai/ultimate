// `x ci` — one command instead of three. `gh run view` prints a tree of ticks and one cross, and
// the error is inside a per-job log that is mostly setup noise; for a `verify` job that log tail IS
// the findings block, with its `X_*` codes and executable `fix:` lines already in it. So this
// command fetches the runs, opens only the failed steps' log, and hands back the findings the gate
// already wrote — in the same three-line shape every other Ultimate error is printed in.

import { UltimateError } from '@ultimat3/core';
import type { CiLogLine } from './ci-log';
import { findingsFrom, jobsInLog, parseLogLines, tailOf } from './ci-log';
import type { CiJob, CiRun } from './ci-runs';
import { failedLog, isFailed, isRunning, latestPerWorkflow, listRuns, viewRun } from './ci-runs';
import type { CliCommand, CommandContext } from './command';
import { parseIntFlag } from './flag-number';
import type { GhRepo } from './gh-target';
import { currentBranch, resolveRepo } from './gh-target';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { flagBool, flagString } from './parse';

/**
 * Every catalog key this command renders, declared — `msg()` answers `⟦key⟧` for a key nobody
 * added, which is loud in a terminal and SILENT to a build. `cmd-ci.test.ts` holds this list
 * against the catalog, so a missing string is a failing test rather than a rendered artefact.
 */
export const CI_MESSAGE_KEYS = [
  'cli.ci.failed',
  'cli.ci.green',
  'cli.ci.running',
  'cli.ci.run',
  'cli.ci.job',
  'cli.ci.jobs.other',
  'cli.ci.tail',
  'cli.ci.pending',
  'cli.ci.logs.empty',
] as const;

/** Log lines kept per failed job. Enough to hold a findings block, short enough to read. */
export const TAIL_LINES = 40;

/** How far back a branch's run history is read before "the latest run of each workflow". */
export const RUN_LOOKBACK = 20;

/** No run to triage. The remedy is a branch that has one, or the id of the run in question. */
export class CiRunNotFoundError extends UltimateError {
  constructor(input: { branch: string; repo: string }) {
    super({
      code: 'X_CI_RUN_NOT_FOUND',
      cause: `no workflow run on ${input.repo} for branch "${input.branch}"`,
      fix: `x ci --branch main --repo ${input.repo} --json`,
    });
  }
}

const RUN_FLAG = { name: 'run', command: 'ci', min: 1, example: 'x ci --run 32484583944 --json' };
const TAIL_FLAG = { name: 'tail', command: 'ci', min: 1, example: 'x ci --tail 80 --json' };

export const ciCommand: CliCommand = {
  spec: {
    name: 'ci',
    summary: 'the workflow runs for this branch, and the findings inside the failed steps log',
    usage: 'x ci [--branch <name>] [--run <id>] [--repo owner/name] [--tail <n>] [--full] [--json]',
    flags: [
      { name: 'repo', type: 'string', summary: 'owner/name; the checkout own remote by default' },
      { name: 'branch', type: 'string', summary: 'branch to read runs for; this one by default' },
      { name: 'run', type: 'string', summary: 'one run id, instead of this branch latest' },
      {
        name: 'tail',
        type: 'string',
        summary: `log lines kept per failed job (default ${TAIL_LINES})`,
      },
      { name: 'full', type: 'boolean', summary: 'the whole failed-step log, not the tail' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const repo = await resolveRepo(ctx, 'ci', flagString(ctx.args, 'repo'));
    const rawRun = flagString(ctx.args, 'run');
    const rawTail = flagString(ctx.args, 'tail');
    const limit = flagBool(ctx.args, 'full')
      ? Number.POSITIVE_INFINITY
      : rawTail === undefined
        ? TAIL_LINES
        : parseIntFlag(rawTail, TAIL_FLAG);
    if (rawRun !== undefined) {
      const viewed = await viewRun(ctx, repo, parseIntFlag(rawRun, RUN_FLAG));
      return report(repo, viewed.run.branch, [await inspect(ctx, repo, viewed, limit)]);
    }
    const branch = flagString(ctx.args, 'branch') ?? (await currentBranch(ctx));
    const runs = latestPerWorkflow(await listRuns(ctx, repo, branch, RUN_LOOKBACK));
    if (runs.length === 0) throw new CiRunNotFoundError({ branch, repo: repo.slug });
    const inspected: RunReport[] = [];
    for (const run of runs) {
      // Only a failed run is opened. A green run's jobs are 35 rows saying `success`, and fetching
      // them would turn the fast answer ("CI is green") into the slow one.
      inspected.push(
        isFailed(run) ? await inspect(ctx, repo, await viewRun(ctx, repo, run.id), limit) : { run },
      );
    }
    return report(repo, branch, inspected);
  },
};

interface JobFailure {
  readonly job: string;
  readonly conclusion: string;
  readonly url: string;
  readonly failedSteps: readonly string[];
  readonly tail: readonly string[];
}

interface RunReport {
  readonly run: CiRun;
  readonly jobs?: readonly CiJob[];
  readonly failures?: readonly JobFailure[];
  readonly findings?: readonly Finding[];
}

const stepFailed = (conclusion: string | null): boolean =>
  conclusion !== null && conclusion !== 'success' && conclusion !== 'skipped';

/**
 * One failed run, opened. The findings are attributed to the job whose lines produced them, and
 * a job the log attributes nothing to falls back to the whole log — a format change on GitHub's
 * side must cost the attribution, never the finding.
 */
async function inspect(
  ctx: CommandContext,
  repo: GhRepo,
  viewed: { readonly run: CiRun; readonly jobs: readonly CiJob[] },
  limit: number,
): Promise<RunReport> {
  const { run, jobs } = viewed;
  if (!isFailed(run)) return { run, jobs };
  const lines = parseLogLines(await failedLog(ctx, repo, run.id));
  const failed = jobs.filter((job) => stepFailed(job.conclusion));
  // A run can fail with no failed JOB — a startup failure, a cancelled matrix — and the log is
  // then the only thing that knows which name to file it under.
  const names = failed.length > 0 ? failed.map((job) => job.name) : jobsInLog(lines);
  const failures: JobFailure[] = [];
  const findings: Finding[] = [];
  for (const name of names) {
    const own = lines.filter((line) => line.job === name);
    const pool: readonly CiLogLine[] = own.length > 0 ? own : lines;
    const job = failed.find((candidate) => candidate.name === name);
    for (const finding of findingsFrom(pool)) {
      findings.push(finding.at === undefined ? { ...finding, at: name } : finding);
    }
    failures.push({
      job: name,
      conclusion: job?.conclusion ?? conclusionOf(run),
      url: job?.url ?? run.url,
      failedSteps: (job?.steps ?? [])
        .filter((step) => stepFailed(step.conclusion))
        .map((step) => step.name),
      tail: tailOf(lines, name, limit),
    });
  }
  return { run, jobs, failures, findings: dedupe(findings) };
}

/**
 * The same block can be reached twice — once per job when the log attributes nothing, once per
 * attempt when a run was re-run — and two copies of one finding read as two problems.
 */
function dedupe(findings: readonly Finding[]): readonly Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code} ${finding.cause}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const conclusionOf = (run: CiRun): string => run.conclusion ?? msg('cli.ci.pending');

function report(repo: GhRepo, branch: string, reports: readonly RunReport[]): CommandResult {
  const failed = reports.filter((entry) => isFailed(entry.run));
  const running = reports.filter((entry) => isRunning(entry.run));
  const findings = dedupe(reports.flatMap((entry) => entry.findings ?? []));
  return {
    ok: failed.length === 0,
    command: 'ci',
    summary:
      failed.length > 0
        ? msg('cli.ci.failed', {
            failed: failed.length,
            runs: reports.length,
            branch,
            findings: findings.length,
          })
        : running.length > 0
          ? msg('cli.ci.running', { running: running.length, runs: reports.length, branch })
          : msg('cli.ci.green', { runs: reports.length, branch }),
    findings,
    lines: reports.flatMap(runLines),
    data: {
      repo: repo.slug,
      branch,
      counts: {
        runs: reports.length,
        failed: failed.length,
        running: running.length,
        findings: findings.length,
      },
      runs: reports.map(runJson),
    },
  };
}

function runLines(entry: RunReport): readonly string[] {
  const out = [
    msg('cli.ci.run', {
      conclusion: conclusionOf(entry.run),
      workflow: entry.run.workflow,
      url: entry.run.url,
    }),
  ];
  const failures = entry.failures ?? [];
  for (const failure of failures) {
    out.push(
      msg('cli.ci.job', {
        conclusion: failure.conclusion,
        job: failure.job,
        steps: failure.failedSteps.join(', '),
      }),
    );
    if (failure.tail.length === 0) {
      out.push(msg('cli.ci.logs.empty', { url: failure.url }));
      continue;
    }
    out.push(msg('cli.ci.tail', { job: failure.job }));
    for (const line of failure.tail) out.push(`      | ${line}`);
  }
  const jobs = entry.jobs;
  if (jobs !== undefined && jobs.length > failures.length) {
    out.push(msg('cli.ci.jobs.other', { count: jobs.length - failures.length }));
  }
  return out;
}

function runJson(entry: RunReport): JsonValue {
  return {
    id: entry.run.id,
    workflow: entry.run.workflow,
    status: entry.run.status,
    conclusion: entry.run.conclusion,
    title: entry.run.title,
    url: entry.run.url,
    createdAt: entry.run.createdAt,
    // Absent rather than empty on a run that was never opened: `jobs: []` on a green run would
    // claim the run has no jobs, which is a different statement from "nobody asked".
    ...(entry.jobs === undefined
      ? {}
      : {
          jobs: entry.jobs.map((job) => ({
            name: job.name,
            status: job.status,
            conclusion: job.conclusion,
            url: job.url,
          })),
        }),
    ...(entry.failures === undefined
      ? {}
      : {
          failures: entry.failures.map((failure) => ({
            job: failure.job,
            url: failure.url,
            failedSteps: [...failure.failedSteps],
            tail: [...failure.tail],
          })),
        }),
  };
}
