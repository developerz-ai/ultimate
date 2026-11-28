// The finished rows read off GitHub's run history: each shape's `scaffold-smoke (<shape>app)` job
// green on the newest push that ran it (skipped or cancelled is no evidence), four scheduled
// weekly `flake-hunt` runs green in a row, and the newest `compat.yml` run green. `gh` is injected; an
// answer it could not give is `unverdicted`, never green.

import { renderFixShellArg } from '../packages/core/src/error-render';
import { isJsonObject } from '../packages/core/src/json-object';
import type { FinishedRow, Runner } from './finished-rule';
import { green, parsedOutput, RERUN, red, unverdicted } from './finished-rule';
import { COMPAT_COMMAND, compatReader, judgeCompat } from './lib/health-compat';
import type { Finding } from './lib/log';

/** How far back a shape's job is looked for: a push that skipped scaffold-smoke is no evidence. */
export const SHAPE_RUN_DEPTH = 10;
/** Four weekly hunts of four rounds: sixteen shuffled orders per suite (`flake-hunt.yml`). */
export const FLAKE_WEEKS = 4;
/** A week plus a late runner's slack: an older newest run means the schedule stopped. */
const WEEK_MS = 8 * 24 * 60 * 60 * 1000;

const CI_RUNS = [
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
  String(SHAPE_RUN_DEPTH),
  '--json',
  'databaseId,headSha,url',
];
const FLAKE_RUNS = [
  'run',
  'list',
  '--workflow',
  'flake-hunt.yml',
  '--branch',
  'main',
  '--event',
  'schedule',
  '--status',
  'completed',
  '--limit',
  String(FLAKE_WEEKS),
  '--json',
  'conclusion,createdAt,url',
];
export const SHAPES_COMMAND = `gh ${CI_RUNS.join(' ')}; gh run view <id> --json jobs`;
export const FLAKE_COMMAND = `gh ${FLAKE_RUNS.join(' ')}`;

export const shapeJob = (shape: string): string => `scaffold-smoke (${shape}app)`;

interface Job {
  readonly name: string;
  readonly conclusion: string;
}

const jobsOf = (doc: unknown): readonly Job[] | undefined => {
  const jobs = isJsonObject(doc) ? doc['jobs'] : undefined;
  if (!Array.isArray(jobs)) return undefined;
  return jobs.flatMap((job: unknown): Job[] =>
    isJsonObject(job) && typeof job['name'] === 'string'
      ? [
          {
            name: job['name'],
            conclusion: typeof job['conclusion'] === 'string' ? job['conclusion'] : '',
          },
        ]
      : [],
  );
};

export async function shapesRow(
  shapes: readonly string[],
  root: string,
  gh: Runner,
): Promise<FinishedRow> {
  const runs = parsedOutput(await gh(CI_RUNS, root));
  if (!Array.isArray(runs)) return unverdicted('every-shape-gates', SHAPES_COMMAND, 'no run list');
  const verdicts = new Map<string, { conclusion: string; url: string }>();
  for (const run of runs) {
    if (verdicts.size === shapes.length) break;
    if (!isJsonObject(run) || typeof run['databaseId'] !== 'number') continue;
    const id = run['databaseId'];
    const jobs = jobsOf(
      parsedOutput(await gh(['run', 'view', String(id), '--json', 'jobs'], root)),
    );
    if (jobs === undefined) return unverdicted('every-shape-gates', SHAPES_COMMAND, `run ${id}`);
    for (const shape of shapes) {
      const job = jobs.find((one) => one.name === shapeJob(shape));
      if (
        verdicts.has(shape) ||
        job === undefined ||
        ['skipped', 'cancelled', ''].includes(job.conclusion)
      ) {
        continue;
      }
      verdicts.set(shape, { conclusion: job.conclusion, url: String(run['url']) });
    }
  }
  const findings = shapes.flatMap((shape): Finding[] => {
    const seen = verdicts.get(shape);
    if (seen?.conclusion === 'success') return [];
    return [
      {
        code: 'X_FINISHED_SHAPE_UNGATED',
        cause:
          seen === undefined
            ? `no push to main ran ${shapeJob(shape)} in its last ${SHAPE_RUN_DEPTH} completed ci.yml runs`
            : `${shapeJob(shape)} ended ${seen.conclusion} on main: ${seen.url}`,
        fix: `bun run x -- new ${renderFixShellArg(`${shape}app`, '<name>')} --shape ${renderFixShellArg(shape, '<shape>')} --json   # in a scratch directory, then run the strict gate in that app twice (bun run verify); the job's own log names the red step`,
        at: '.github/workflows/ci.yml',
      },
    ];
  });
  return findings.length === 0
    ? green('every-shape-gates', `scaffold-smoke green on main for ${shapes.join(', ')}`)
    : red(
        'every-shape-gates',
        `${findings.length} of ${shapes.length} shapes not green on main`,
        findings,
      );
}

export async function flakeRow(root: string, gh: Runner, nowMs: number): Promise<FinishedRow> {
  const runs = parsedOutput(await gh(FLAKE_RUNS, root));
  if (!Array.isArray(runs)) return unverdicted('tests-deterministic', FLAKE_COMMAND, 'no run list');
  const weeks = runs.filter(isJsonObject);
  const greenWeeks = weeks.filter((run) => run['conclusion'] === 'success').length;
  const newest = Date.parse(String(weeks[0]?.['createdAt'] ?? ''));
  const fresh = nowMs - newest <= WEEK_MS;
  if (weeks.length === FLAKE_WEEKS && greenWeeks === FLAKE_WEEKS && fresh) {
    return green('tests-deterministic', `the last ${FLAKE_WEEKS} scheduled flake hunts passed`);
  }
  const why = !fresh
    ? `the newest scheduled flake hunt is not from the last eight days (${weeks.length === 0 ? 'none ran' : String(weeks[0]?.['createdAt'])})`
    : `${greenWeeks} of the last ${weeks.length} scheduled flake hunts passed, and ${FLAKE_WEEKS} green weekly runs in a row are the bar`;
  return red('tests-deterministic', why, [
    {
      code: 'X_FINISHED_FLAKY',
      cause: why,
      fix: 'gh issue list --label flake-hunt --state open   # each names a test, its seed and its rerun; a stopped schedule: gh workflow enable flake-hunt.yml',
      at: '.github/workflows/flake-hunt.yml',
    },
  ]);
}

export async function compatRow(root: string, gh: Runner, nowMs: number): Promise<FinishedRow> {
  const judged = judgeCompat(await compatReader(root, gh), nowMs);
  if (!('verdict' in judged)) return unverdicted('range-tested', COMPAT_COMMAND, judged.cause);
  if (judged.verdict === 'healthy') return green('range-tested', judged.reason);
  if (judged.verdict === 'unverdicted') {
    return unverdicted('range-tested', COMPAT_COMMAND, judged.reason);
  }
  return red('range-tested', judged.reason, [
    {
      code: 'X_FINISHED_COMPAT_RED',
      cause: `the supported range is not tested green: ${judged.reason}${judged.url === undefined ? '' : ` (${judged.url})`}`,
      fix: `${judged.fix ?? 'gh issue list --label compat --state open'}   # then: ${RERUN}`,
      at: '.github/workflows/compat.yml',
    },
  ]);
}
