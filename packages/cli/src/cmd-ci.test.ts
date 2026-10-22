// `x ci`, and the log reader under it. The fixture is a verbatim excerpt of a real
// `gh run view --log-failed` — tab columns, BOM, ANSI, `##[group]` and all — because the whole
// claim of this command is that the framework's own findings block survives that transport and
// comes back out as findings.

import { describe, expect, test } from 'bun:test';
import { REQUIRED_BUN } from './app-root';
import { findingKey, findingsFrom, jobsInLog, parseLogLines, tailOf } from './ci-log';
import type { CiRun } from './ci-runs';
import { isFailed, latestPerWorkflow, RUN_FIELDS } from './ci-runs';
import { CI_MESSAGE_KEYS, ciCommand, RUN_LOOKBACK, TAIL_LINES } from './cmd-ci';
import type { CommandContext } from './command';
import type { ExecResult, Runner } from './exec';
import { messageKeys } from './messages';
import type { Finding } from './output';
import { parseArgs } from './parse';

const line = (job: string, stamp: string, text: string, bom = false): string =>
  `${job}\ttest + coverage\t${bom ? '﻿' : ''}2026-08-21T13:0${stamp}Z ${text}`;

/** Two failed matrix jobs, exactly as Actions serialises them. */
const LOG = [
  line('package (cli)', '0:28.5417227', '##[group]Run bun run scripts/coverage-gate.ts', true),
  line('package (cli)', '0:28.5417946', '[36;1mbun run scripts/coverage-gate.ts[0m'),
  line('package (cli)', '0:28.5461319', '##[endgroup]'),
  line('package (cli)', '1:30.9733457', '  X_COVERAGE_UNMEASURED (packages/cli)'),
  line(
    'package (cli)',
    '1:30.9736546',
    '    cause: bun test wrote no lcov report for packages/cli',
  ),
  line('package (cli)', '1:30.9739891', '    fix:   run bun test packages/cli and fix the failure'),
  line('package (cli)', '1:30.9798141', '##[error]Process completed with exit code 1.'),
  line('package (testing)', '0:24.4392772', '  X_COVERAGE_BELOW (packages/testing)', true),
  line('package (testing)', '0:24.4393704', '    cause: packages/testing/src/ is at 96.37% lines'),
  line(
    'package (testing)',
    '0:24.4416784',
    '    fix:   cover the gap with tests beside the source',
  ),
].join('\n');

describe('unit · an Actions log line is three things before it is text', () => {
  test('the two columns, the timestamp, the BOM and the colour all come off', () => {
    const lines = parseLogLines(LOG);
    expect(lines[0]?.job).toBe('package (cli)');
    expect(lines[0]?.step).toBe('test + coverage');
    expect(lines[0]?.text).toBe('Run bun run scripts/coverage-gate.ts');
    expect(lines[1]?.text).toBe('bun run scripts/coverage-gate.ts');
    // `##[endgroup]` carries nothing and is dropped, so it never lands in a tail.
    expect(lines.some((entry) => entry.text.includes('endgroup'))).toBe(false);
    expect(jobsInLog(lines)).toEqual(['package (cli)', 'package (testing)']);
  });

  test('a line with no columns is kept whole and attributed to no job', () => {
    const lines = parseLogLines('a bare line\n\nanother');
    expect(lines).toEqual([
      { job: '', step: '', text: 'a bare line' },
      { job: '', step: '', text: 'another' },
    ]);
  });
});

describe('unit · the findings block survives the transport', () => {
  test('code, locator, cause and fix come back as the Finding the gate printed', () => {
    const found = findingsFrom(parseLogLines(LOG));
    expect(found).toHaveLength(2);
    expect(found[0]).toEqual({
      code: 'X_COVERAGE_UNMEASURED',
      at: 'packages/cli',
      cause: 'bun test wrote no lcov report for packages/cli',
      fix: 'run bun test packages/cli and fix the failure',
    });
    expect(found[1]?.code).toBe('X_COVERAGE_BELOW');
  });

  // Every `x verify` summary, and every fix line quoting a code, starts with `X_`. Reconstructing
  // a finding from one would hand the reader a cause the gate never wrote.
  test('a code with no cause and fix under it is not a finding', () => {
    const prose = parseLogLines(
      ['X_COVERAGE_BELOW is what this job reports', 'see above', 'X_TEST_FAILED'].join('\n'),
    );
    expect(findingsFrom(prose)).toEqual([]);
  });

  test('a re-run repeating the same block is one finding, not two', () => {
    expect(findingsFrom(parseLogLines(`${LOG}\n${LOG}`))).toHaveLength(2);
  });

  test('the tail is the job own last lines, and the whole log when it has none', () => {
    const lines = parseLogLines(LOG);
    expect(tailOf(lines, 'package (testing)', 2)).toEqual([
      '    cause: packages/testing/src/ is at 96.37% lines',
      '    fix:   cover the gap with tests beside the source',
    ]);
    expect(tailOf(lines, 'nobody', 1)).toEqual([
      '    fix:   cover the gap with tests beside the source',
    ]);
  });
});

const run = (over: Partial<CiRun> = {}): CiRun => ({
  id: 1,
  status: 'completed',
  conclusion: 'success',
  branch: 'feat/x',
  title: 'a change',
  workflow: 'ci',
  url: 'https://github.com/o/r/actions/runs/1',
  createdAt: '2026-08-21T10:00:00Z',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  ...over,
});

describe('unit · which run x ci is about', () => {
  // This repo pushes `ci` and `deploy-social-demo` off one commit, so "the newest run" is a
  // verdict about whichever workflow happened to finish last.
  test('the newest run of each workflow, never the newest run overall', () => {
    const picked = latestPerWorkflow([
      run({ id: 1, workflow: 'ci', createdAt: '2026-08-21T10:00:00Z' }),
      run({ id: 2, workflow: 'ci', createdAt: '2026-08-21T12:00:00Z' }),
      run({ id: 3, workflow: 'deploy', createdAt: '2026-08-21T11:00:00Z' }),
    ]);
    expect(picked.map((entry) => entry.id).sort()).toEqual([2, 3]);
  });

  // A cancelled run has told the reader nothing about their change, and a green verdict over an
  // unanswered question is the false pass this list exists to prevent.
  test('cancelled and timed out are not green; skipped and success are not failures', () => {
    expect(isFailed(run({ conclusion: 'cancelled' }))).toBe(true);
    expect(isFailed(run({ conclusion: 'timed_out' }))).toBe(true);
    expect(isFailed(run({ conclusion: 'skipped' }))).toBe(false);
    expect(isFailed(run({ conclusion: null }))).toBe(false);
  });
});

const RUN_ROW = {
  databaseId: 32484583944,
  status: 'completed',
  conclusion: 'failure',
  headBranch: 'feat/x',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  displayTitle: 'a change',
  workflowName: 'ci',
  url: 'https://github.com/o/r/actions/runs/32484583944',
  createdAt: '2026-08-21T12:59:51Z',
};

const JOBS = [
  { name: 'verify', status: 'completed', conclusion: 'success', url: 'u/verify', steps: [] },
  {
    name: 'package (cli)',
    status: 'completed',
    conclusion: 'failure',
    url: 'u/cli',
    steps: [
      { name: 'checkout', conclusion: 'success', number: 1 },
      { name: 'test + coverage', conclusion: 'failure', number: 2 },
    ],
  },
  {
    name: 'package (testing)',
    status: 'completed',
    conclusion: 'failure',
    url: 'u/testing',
    steps: [{ name: 'test + coverage', conclusion: 'failure', number: 2 }],
  },
];

/** Answers by the first predicate that matches the argv, and records every call. */
function ghTable(answer: (joined: string) => string | undefined): {
  runner: Runner;
  ran: string[][];
} {
  const ran: string[][] = [];
  const runner: Runner = async (command): Promise<ExecResult> => {
    ran.push([...command]);
    const stdout = answer(command.join(' '));
    if (stdout === undefined) expect.unreachable(`no reply for: ${command.join(' ')}`);
    return { command, code: 0, ok: true, stdout, stderr: '', durationMs: 1 };
  };
  return { runner, ran };
}

const REPO = '{"nameWithOwner":"developerz-ai/ultimate"}';

const failing = (joined: string): string | undefined => {
  if (joined.startsWith('gh repo view')) return REPO;
  if (joined.startsWith('git rev-parse')) return 'feat/x\n';
  if (joined.includes('--log-failed')) return LOG;
  if (joined.startsWith('gh run list')) return JSON.stringify([RUN_ROW]);
  if (joined.startsWith('gh run view')) return JSON.stringify({ ...RUN_ROW, jobs: JOBS });
  return undefined;
};

const contextFor = (argv: readonly string[], runner: Runner): CommandContext => ({
  args: parseArgs(argv, [ciCommand.spec]),
  cwd: '/repo',
  runner,
  env: {},
  bunVersion: REQUIRED_BUN,
});

/**
 * RED until the rows are pasted into `messages.ts`. `msg()` renders `⟦key⟧` for a key nobody
 * added, which a build never sees.
 */
describe('unit · every message key x ci renders exists', () => {
  test('the declared keys are in the catalog', () => {
    const known = new Set(messageKeys());
    for (const key of CI_MESSAGE_KEYS) expect([key, known.has(key)]).toEqual([key, true]);
  });
});

describe('unit · the x ci surface', () => {
  test('no subcommands, no app root, and every flag its usage names', () => {
    expect(ciCommand.spec.subcommands).toBeUndefined();
    expect(ciCommand.spec.requiresApp).toBeUndefined();
    const flags = ciCommand.spec.flags?.map((flag) => flag.name) ?? [];
    for (const flag of ['repo', 'branch', 'run', 'tail', 'full']) expect(flags).toContain(flag);
  });
});

describe('unit · x ci is triage in one command', () => {
  test('a failed run is opened, and the gate own findings come back as findings', async () => {
    const { runner, ran } = ghTable(failing);
    const result = await ciCommand.run(contextFor(['ci'], runner));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_COVERAGE_UNMEASURED',
      'X_COVERAGE_BELOW',
    ]);
    // The fix line is the one the gate wrote, carried through verbatim — but FENCED and tagged
    // (row q): a CI log is text anyone who can push a branch writes, and a reconstructed `fix:`
    // arriving as an ordinary finding is prompt injection with a shell attached.
    const first = result.findings?.[0];
    expect(first?.source).toBe('ci-log');
    expect(first?.fix.split('\n')).toEqual([
      '<comment id="ci-log package (cli)">',
      'run bun test packages/cli and fix the failure',
      '</comment>',
    ]);
    expect(result.lines?.filter((line) => line.includes('<comment id="ci-log')).length).toBe(2);
    // The whole argv, because the value of this command is that a reader never assembles one:
    // `--log-failed` and not `--log` (the whole run is mostly setup), and `--json` with the exact
    // field list both calls share.
    expect(ran).toEqual([
      ['gh', 'repo', 'view', '--json', 'nameWithOwner'],
      ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
      // biome-ignore format: one call per line reads as the round trips it is.
      ['gh', 'run', 'list', '--repo', 'developerz-ai/ultimate', '--branch', 'feat/x', '--limit', String(RUN_LOOKBACK), '--json', RUN_FIELDS],
      // biome-ignore format: as above.
      ['gh', 'run', 'view', '32484583944', '--repo', 'developerz-ai/ultimate', '--json', `${RUN_FIELDS},jobs`],
      ['gh', 'run', 'view', '32484583944', '--repo', 'developerz-ai/ultimate', '--log-failed'],
    ]);
  });

  test('the failed jobs and their steps are named, and the other jobs are counted not listed', async () => {
    const { runner } = ghTable(failing);
    const result = await ciCommand.run(contextFor(['ci'], runner));
    const data = result.data as {
      counts: { runs: number; failed: number; running: number; findings: number };
      runs: readonly {
        headSha: string;
        jobs: readonly { name: string }[];
        failures: readonly {
          job: string;
          failedSteps: readonly string[];
          tail: readonly string[];
        }[];
      }[];
    };
    expect(data.counts).toEqual({ runs: 1, failed: 1, running: 0, findings: 2 });
    expect(data.runs[0]?.headSha).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(data.runs[0]?.jobs).toHaveLength(3);
    expect(data.runs[0]?.failures.map((failure) => failure.job)).toEqual([
      'package (cli)',
      'package (testing)',
    ]);
    expect(data.runs[0]?.failures[0]?.failedSteps).toEqual(['test + coverage']);
  });

  // A green run's jobs are 35 rows saying `success`. Fetching them turns the fast answer into the
  // slow one, so the command must not ask.
  test('a green run is never opened, and the verdict is ok', async () => {
    const { runner, ran } = ghTable((joined) => {
      if (joined.startsWith('gh repo view')) return REPO;
      if (joined.startsWith('git rev-parse')) return 'main\n';
      if (joined.startsWith('gh run list'))
        return JSON.stringify([{ ...RUN_ROW, conclusion: 'success' }]);
      return undefined;
    });
    const result = await ciCommand.run(contextFor(['ci'], runner));
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(ran.some((command) => command.includes('view') && command.includes('run'))).toBe(false);
    // Absent, not empty: `jobs: []` on a run nobody opened would claim it has none.
    expect(JSON.parse(JSON.stringify(result.data)).runs[0].jobs).toBeUndefined();
  });

  // A run with no conclusion has not answered yet. `isFailed` is false for it (ci-runs.ts), so
  // `ok: true` is right — but `running: 0` would read as green CI, so the verdict has to carry the
  // `headSha` to watch. This case dies with the `isRunning` filter at cmd-ci.ts:171.
  test('a run still going is ok, and counted running with its head sha', async () => {
    const { runner } = ghTable((joined) => {
      if (joined.startsWith('gh repo view')) return REPO;
      if (joined.startsWith('git rev-parse')) return 'main\n';
      if (joined.startsWith('gh run list'))
        return JSON.stringify([{ ...RUN_ROW, status: 'in_progress', conclusion: null }]);
      return undefined;
    });
    const result = await ciCommand.run(contextFor(['ci'], runner));
    const data = result.data as {
      counts: { runs: number; failed: number; running: number };
      runs: readonly { headSha: string }[];
    };
    expect(result.ok).toBe(true);
    expect([data.counts.runs, data.counts.failed, data.counts.running]).toEqual([1, 0, 1]);
    expect(data.runs[0]?.headSha).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  test('--run names the run, so neither the branch nor the run list is asked for', async () => {
    const { runner, ran } = ghTable(failing);
    await ciCommand.run(contextFor(['ci', '--run', '32484583944'], runner));
    expect(ran.some((command) => command[0] === 'git')).toBe(false);
    expect(ran.some((command) => command.join(' ').startsWith('gh run list'))).toBe(false);
  });

  test('--tail bounds the log kept per job, and the default is TAIL_LINES', async () => {
    const { runner } = ghTable(failing);
    const result = await ciCommand.run(contextFor(['ci', '--tail', '2'], runner));
    const data = result.data as { runs: readonly { failures: readonly { tail: string[] }[] }[] };
    expect(data.runs[0]?.failures[0]?.tail).toHaveLength(2);
    expect(TAIL_LINES).toBeGreaterThan(2);
  });

  test('a branch with no run at all is a coded refusal naming --branch', async () => {
    const { runner } = ghTable((joined) => {
      if (joined.startsWith('gh repo view')) return REPO;
      if (joined.startsWith('git rev-parse')) return 'feat/nothing\n';
      if (joined.startsWith('gh run list')) return '[]';
      return undefined;
    });
    const error = await ciCommand.run(contextFor(['ci'], runner)).then(
      () => ({}) as { code?: string; fix?: string },
      (thrown: unknown) => thrown as { code?: string; fix?: string },
    );
    expect(error.code).toBe('X_CI_RUN_NOT_FOUND');
    expect(error.fix).toContain('--branch');
  });
});

/**
 * One code, one cause, and a locator that differs. `ci-log`'s dedupe already keys on `at` and
 * `meta.step` (`ci-log.ts:114`); `cmd-ci.ts`'s second dedupe — the one that folds findings across
 * jobs and across runs — used to key on code and cause alone, so it read the second as a copy of
 * the first and dropped it. The gate printed two problems and `x ci` reported one.
 */
describe('unit · x ci dedupes a finding by everything the gate printed about it', () => {
  /** The two blocks verbatim, as `renderFinding` wrote them in the failing job. */
  const BLOCK = [
    line('package (cli)', '1:30.9733457', '  X_COVERAGE_BELOW (packages/cli)'),
    line('package (cli)', '1:30.9736546', '    cause: lines below the floor'),
    line('package (cli)', '1:30.9739891', '    fix:   cover the gap with tests beside the source'),
    line('package (cli)', '1:31.9733457', '  X_COVERAGE_BELOW (packages/testing)'),
    line('package (cli)', '1:31.9736546', '    cause: lines below the floor'),
    line('package (cli)', '1:31.9739891', '    fix:   cover the gap with tests beside the source'),
  ].join('\n');

  const ONE_JOB = {
    name: 'package (cli)',
    status: 'completed',
    conclusion: 'failure',
    url: 'u/cli',
    steps: [{ name: 'test + coverage', conclusion: 'failure', number: 2 }],
  };

  /** The same `gh` answers as `failing`, over a log of this test's own choosing. */
  const answering = (log: string): Runner =>
    ghTable((joined) => {
      if (joined.startsWith('gh repo view')) return REPO;
      if (joined.startsWith('git rev-parse')) return 'feat/x\n';
      if (joined.includes('--log-failed')) return log;
      if (joined.startsWith('gh run list')) return JSON.stringify([RUN_ROW]);
      if (joined.startsWith('gh run view')) return JSON.stringify({ ...RUN_ROW, jobs: [ONE_JOB] });
      return undefined;
    }).runner;

  test('the same code and cause at two paths are two findings, not one copy of the first', async () => {
    // The command-level round-trip: `findingsFrom` reads both blocks out of one log, and the
    // across-job dedupe must hand both back. A key of `code cause` alone merges them.
    const result = await ciCommand.run(contextFor(['ci'], answering(BLOCK)));
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_COVERAGE_BELOW', 'packages/cli'],
      ['X_COVERAGE_BELOW', 'packages/testing'],
    ]);
    expect(result.findings).toHaveLength(2);
  });

  // Same code, same cause, no path — the pair that is indistinguishable unless `meta.step` is in
  // the key. `X_VERIFY_MERGE_INCOMPLETE` is the shape the gate really writes: a merge gap per
  // missing step, each with a step name in the head and none in `at`.
  test('the same code and cause in two gate steps are two findings too', async () => {
    const steps = [
      line('verify', '0:10.0000000', '  X_VERIFY_MERGE_INCOMPLETE [step=lint]'),
      line('verify', '0:10.1000000', '    cause: its result never arrived'),
      line('verify', '0:10.2000000', '    fix:   gh run rerun <run-id> --failed'),
      line('verify', '0:11.0000000', '  X_VERIFY_MERGE_INCOMPLETE [step=manifest]'),
      line('verify', '0:11.1000000', '    cause: its result never arrived'),
      line('verify', '0:11.2000000', '    fix:   gh run rerun <run-id> --failed'),
    ].join('\n');
    const result = await ciCommand.run(contextFor(['ci'], answering(steps)));
    expect(result.findings?.map((finding) => finding.meta?.['step'])).toEqual(['lint', 'manifest']);
  });

  // Both halves of the fix, in one assertion: what ci-log keeps apart, the command keeps apart,
  // and what is genuinely the same block is still folded to one. A key that took every field
  // would stop folding anything and report a re-run twice.
  test('a repeated block is still one finding, and the key is the one ci-log used', () => {
    const pair = (at: string, step: string): Finding => ({
      code: 'X_VERIFY_STEP_TIMEOUT',
      cause: 'step "unit" passed its 300000ms deadline',
      fix: 'bun test packages/cli',
      at,
      meta: { step },
    });
    const same = pair('packages/cli/src/output.test.ts', 'unit');
    // The `fix:` line is not in the key: a re-run reprints the whole block, and `x ci` fences it
    // differently per job, so keying on it would report the re-run twice.
    expect(findingKey(same)).toBe(findingKey({ ...same, fix: 'a re-run wrote another fix line' }));
    expect(findingKey(same)).not.toBe(findingKey(pair('packages/cli/src/other.test.ts', 'unit')));
    expect(findingKey(same)).not.toBe(findingKey(pair('packages/cli/src/output.test.ts', 'live')));
    // An absent locator is the empty string, not the word "undefined" — and it is the same
    // absence `findingsFrom` reconstructs for a head the renderer wrote without one.
    const bare: Finding = { code: 'X_A', cause: 'c', fix: 'f' };
    expect(findingKey(bare)).toBe('X_A\0c\0\0');
    expect(findingKey({ ...bare, meta: { step: ['lint'] } })).toBe('X_A\0c\0\0');
  });
});
