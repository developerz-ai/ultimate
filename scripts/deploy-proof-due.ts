#!/usr/bin/env bun
// Is ci.yml's `deploy-proof` due on this push to main? It may skip only when no file that decides
// the rolling upgrade moved since a commit whose proof PASSED. Diffing against `github.event.before`
// alone let a red proof on A be hidden by a B that touched no deciding path, and release.yml then
// published from B (plan 101 K15). Unknown is never a skip: every doubt runs the proof.
//
//   bun run scripts/deploy-proof-due.ts [--json]     (ci.yml; writes run= to $GITHUB_OUTPUT)

import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';

/**
 * The files whose change can change the proof's answer: the chart, the image, the serving path —
 * and what `docker/deploy-proof/run.sh` builds them WITH: every `packages/<pkg>/package.json`
 * (each package is packed into the proof app, so its manifest decides what ships), the setup
 * action (the Bun that packs, scaffolds and builds), the root install the CLI runs on, and this
 * rule itself, so a change to it is proved rather than skipped by itself.
 */
export const VERDICT_PATHS =
  /^(\.github\/workflows\/ci\.yml|\.github\/actions\/setup\/|docker\/|bun\.lock$|package\.json$|scripts\/deploy-proof-due\.ts$|packages\/[^/]+\/package\.json$|packages\/cli\/src\/templates\/scaffold-|packages\/cli\/src\/(cmd-deploy|serve|role-|runtime-)|packages\/core\/src\/lifecycle|packages\/http\/src\/(server|stages)\.ts)/;

/** The job whose conclusion is the verdict being carried forward. Its id in ci.yml. */
export const PROOF_JOB = 'deploy-proof';

/** A `release:` commit is what release.yml publishes from, so its proof is never inherited. */
const RELEASE_SUBJECT = /^release:/;

export interface CiRun {
  readonly id: number;
  readonly runNumber: number;
  readonly headSha: string;
}

/** The previous ci.yml run on main, and what its deploy-proof job concluded (`null`: not yet). */
export interface Predecessor {
  readonly runId: number;
  readonly headSha: string;
  readonly conclusion: string | null;
}

export interface DeployProofInput {
  readonly event: string;
  /** This commit's subject line. */
  readonly subject: string;
  readonly predecessor: Predecessor | undefined;
  /** Files changed between the predecessor's commit and this one; undefined when unreadable. */
  readonly changed: readonly string[] | undefined;
}

export interface DeployProofDecision {
  readonly run: boolean;
  readonly reason: string;
  /** The green commit a skip inherits its verdict from. Only on a skip. */
  readonly base?: string;
}

/** The first changed file that decides the verdict, or undefined when none does. */
export const touchesVerdict = (changed: readonly string[]): string | undefined =>
  changed.find((file) => VERDICT_PATHS.test(file));

/**
 * The one rule. A skip inherits the predecessor's verdict, so it is legal only when that verdict
 * was a pass AND nothing deciding moved since — which makes a chain of skips sound: each one's
 * deciding files equal a commit whose proof was performed and green.
 */
export function deployProofDue(input: DeployProofInput): DeployProofDecision {
  if (input.event !== 'push') return { run: true, reason: `a ${input.event} run always proves` };
  if (RELEASE_SUBJECT.test(input.subject)) {
    return { run: true, reason: 'a release commit is proved on itself, never by inheritance' };
  }
  const { predecessor } = input;
  if (predecessor === undefined) {
    return { run: true, reason: 'no earlier ci.yml run on main could be read to inherit from' };
  }
  if (predecessor.conclusion !== 'success') {
    return {
      run: true,
      reason: `the previous run's ${PROOF_JOB} (run ${String(predecessor.runId)}) is ${predecessor.conclusion ?? 'not finished'}, not success`,
    };
  }
  if (input.changed === undefined) {
    return { run: true, reason: `the diff against ${predecessor.headSha} could not be read` };
  }
  const moved = touchesVerdict(input.changed);
  if (moved !== undefined) {
    return { run: true, reason: `${moved} moved since ${predecessor.headSha}` };
  }
  return {
    run: false,
    reason: `no file that decides the proof moved since ${predecessor.headSha}, whose proof passed (run ${String(predecessor.runId)})`,
    base: predecessor.headSha,
  };
}

const member = (from: unknown, key: string): unknown =>
  typeof from === 'object' && from !== null ? (from as Record<string, unknown>)[key] : undefined;

/** `GET …/workflows/ci.yml/runs`, narrowed. Anything malformed is dropped, never trusted. */
export function parseRuns(payload: unknown): readonly CiRun[] {
  const list = member(payload, 'workflow_runs');
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw: unknown) => {
    const id = member(raw, 'id');
    const runNumber = member(raw, 'run_number');
    const headSha = member(raw, 'head_sha');
    return typeof id === 'number' && typeof runNumber === 'number' && typeof headSha === 'string'
      ? [{ id, runNumber, headSha }]
      : [];
  });
}

/** The newest run that started before this one — a later push is never this one's predecessor. */
export const predecessorRun = (runs: readonly CiRun[], runNumber: number): CiRun | undefined =>
  runs
    .filter((candidate) => candidate.runNumber < runNumber)
    .reduce<CiRun | undefined>(
      (newest, candidate) =>
        newest === undefined || candidate.runNumber > newest.runNumber ? candidate : newest,
      undefined,
    );

/** One job's conclusion in `GET …/runs/<id>/jobs`; null when absent or not finished. */
export function jobConclusion(payload: unknown, name: string): string | null {
  const jobs = member(payload, 'jobs');
  if (!Array.isArray(jobs)) return null;
  const conclusion = member(
    jobs.find((job: unknown) => member(job, 'name') === name),
    'conclusion',
  );
  return typeof conclusion === 'string' ? conclusion : null;
}

/** `gh api <path>` as JSON, or undefined — a read that failed is an unknown, and unknown runs. */
async function ghApi(path: string, cwd: string): Promise<unknown> {
  const answer = await run(['gh', 'api', path], { cwd });
  if (!answer.ok) return undefined;
  try {
    return JSON.parse(answer.output) as unknown;
  } catch {
    return undefined;
  }
}

async function readPredecessor(cwd: string): Promise<Predecessor | undefined> {
  const repo = Bun.env['GITHUB_REPOSITORY'];
  const runNumber = Number(Bun.env['GITHUB_RUN_NUMBER']);
  if (repo === undefined || !Number.isInteger(runNumber)) return undefined;
  const runs = parseRuns(
    await ghApi(
      `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=30`,
      cwd,
    ),
  );
  const previous = predecessorRun(runs, runNumber);
  if (previous === undefined) return undefined;
  // The jobs of the run's LATEST attempt: a red proof re-run green is green.
  const jobs = await ghApi(
    `repos/${repo}/actions/runs/${String(previous.id)}/jobs?per_page=100`,
    cwd,
  );
  return {
    runId: previous.id,
    headSha: previous.headSha,
    conclusion: jobConclusion(jobs, PROOF_JOB),
  };
}

/**
 * Both ends of every change between `base` and HEAD. `--no-renames`: with rename detection on
 * (git's default) a move lists only the NEW path, so a deciding file moved out of VERDICT_PATHS
 * read as an unrelated file appearing and the proof skipped over the change.
 */
export const changedFilesCommand = (base: string): readonly string[] => [
  'git',
  'diff',
  '--no-renames',
  '--name-only',
  base,
  'HEAD',
];

/** The files changed between `base` and HEAD, fetching `base` at depth 1; undefined on failure. */
async function changedSince(base: string, cwd: string): Promise<readonly string[] | undefined> {
  const fetched = await run(['git', 'fetch', '--no-tags', '--depth=1', 'origin', base], { cwd });
  if (!fetched.ok) return undefined;
  const diff = await run(changedFilesCommand(base), { cwd });
  return diff.ok ? diff.output.split('\n').filter((line) => line !== '') : undefined;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const cwd = repoRoot();
  const event = Bun.env['GITHUB_EVENT_NAME'] ?? 'push';
  const subject = await run(['git', 'log', '-1', '--format=%s'], { cwd });
  // Asked only when the answer can matter: a manual run or a release commit proves regardless.
  const asks = event === 'push' && !(subject.ok && RELEASE_SUBJECT.test(subject.output));
  const predecessor = asks ? await readPredecessor(cwd) : undefined;
  const changed =
    predecessor?.conclusion === 'success'
      ? await changedSince(predecessor.headSha, cwd)
      : undefined;
  const decision = deployProofDue({
    event,
    subject: subject.ok ? subject.output : '',
    predecessor,
    changed,
  });
  const output = Bun.env['GITHUB_OUTPUT'];
  if (output !== undefined && output !== '') {
    // Appended, never replaced: the runner may already hold other outputs of this step there.
    const prior = (await Bun.file(output).exists()) ? await Bun.file(output).text() : '';
    await Bun.write(output, `${prior}run=${String(decision.run)}\n`);
  }
  report(
    {
      ok: true,
      script: 'deploy-proof-due',
      summary: `deploy proof runs: ${String(decision.run)} — ${decision.reason}`,
      data: decision,
    },
    args.json,
  );
}
