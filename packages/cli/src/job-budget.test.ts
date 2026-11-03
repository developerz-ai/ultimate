// `X_JOB_OUTLASTS_DRAIN`: a declared `timeout` against the time a deploy gives the worker holding
// that job. Over the budget, a deploy cuts a job that was within its own limit.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { resetJobs } from '@ultimat3/jobs';
import { jobBudgetFindings, readJobBudgetFindings, workerBudgetMs } from './job-budget';
import { VERIFY_STEPS } from './verify-checks';

const HOUR = 3_600_000;
const job = (name: string, timeoutMs: number | undefined) => ({ name, timeoutMs });
const on = { workerRetireMs: HOUR, deadlineMs: 25_000 };

describe('the worker budget', () => {
  test('the retire, when on', () => {
    expect(workerBudgetMs({ ...on, workerDeadlineMs: 2 * HOUR })).toBe(HOUR);
  });

  test('retire off: the worker budget, else the one every role drains on', () => {
    // Less the cut-off's margin: the drain cancels a held job 2 s before its deadline.
    expect(workerBudgetMs({ ...on, workerRetireMs: 0 })).toBe(23_000);
    expect(workerBudgetMs({ ...on, workerRetireMs: 0, workerDeadlineMs: 2 * HOUR })).toBe(
      2 * HOUR - 2_000,
    );
  });

  test('nothing declared is core’s defaults, the retire on', () => {
    expect(workerBudgetMs(undefined)).toBe(HOUR);
    expect(workerBudgetMs({})).toBe(HOUR);
  });
});

describe('a budget that is not a number', () => {
  test('is refused, never read as no budget: a NaN would pass every timeout', () => {
    expect(() => workerBudgetMs({ workerRetireMs: Number.NaN })).toThrow('drain.workerRetireMs');
    expect(() => workerBudgetMs({ workerRetireMs: 0, deadlineMs: Number.NaN })).toThrow(
      'drain.workerDeadlineMs',
    );
  });
});

describe('X_JOB_OUTLASTS_DRAIN', () => {
  test('over: names the job, its limit and the budget, with the value to set', () => {
    const [finding, ...rest] = jobBudgetFindings([job('nightly', 2 * HOUR)], on);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_JOB_OUTLASTS_DRAIN');
    expect(finding?.cause).toContain('nightly');
    expect(finding?.cause).toContain('7200000');
    expect(finding?.cause).toContain('3600000');
    expect(finding?.fix).toBe(
      'drain: { workerRetireMs: 7200000 },   // in app.config.ts, then x verify --only manifest --json',
    );
    expect(finding?.at).toBe('app.config.ts');
  });

  test('under and equal are fine', () => {
    expect(jobBudgetFindings([job('a', HOUR - 1), job('b', HOUR)], on)).toEqual([]);
  });

  test('a job with no timeout is not graded: a limit nobody declared is not comparable', () => {
    expect(jobBudgetFindings([job('a', undefined)], { ...on, workerRetireMs: 0 })).toEqual([]);
  });

  test('retire off grades against the drain budget', () => {
    const off = { ...on, workerRetireMs: 0 };
    expect(jobBudgetFindings([job('a', 23_000)], off)).toEqual([]);
    // '24s' under a 25 s budget: every deploy cancels it at 23 s.
    expect(jobBudgetFindings([job('b', 24_000)], off).map((one) => one.code)).toEqual([
      'X_JOB_OUTLASTS_DRAIN',
    ]);
  });

  test('a limit past what the retire may be set to says to split the job instead', () => {
    const [finding] = jobBudgetFindings([job('epic', 86_400_001)], on);
    expect(finding?.fix).not.toContain('workerRetireMs');
    expect(finding?.fix).toContain('timeout');
    expect(finding?.fix).toContain('epic');
  });

  test('one finding per job, sorted, so the verdict does not depend on registration order', () => {
    const named = jobBudgetFindings([job('z', 2 * HOUR), job('a', 2 * HOUR)], on);
    expect(named.map((one) => one.cause.split(' ')[0])).toEqual(['a', 'z']);
  });
});

describe('the manifest step reads the app', () => {
  const dirs: string[] = [];
  afterAll(() => {
    resetJobs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const appWith = (config: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'job-budget-'));
    dirs.push(root);
    writeFileSync(join(root, 'app.config.ts'), `export const config = ${config};\n`);
    return root;
  };
  const loaded = async () => ({ findings: [] });

  test('a load that failed reports nothing here: the step that loaded it reports the load', async () => {
    const failed = async () => ({
      findings: [{ code: 'X_APP_LOAD_FAILED', cause: 'broken', fix: 'x verify --json' }],
    });
    expect(await readJobBudgetFindings('/nowhere', failed)).toEqual([]);
  });

  test('a config the loader refuses is not this check’s to report', async () => {
    const root = appWith('{ name: "demo", drain: { workerRetireMs: -1 } }');
    expect(await readJobBudgetFindings(root, loaded)).toEqual([]);
  });

  test('x verify’s manifest step reds, naming a 2h job on workerRetireMs: 0', async () => {
    const root = appWith('{ name: "demo", drain: { workerRetireMs: 0 } }');
    const jobsEntry = join(import.meta.dir, '../../jobs/src/index.ts');
    mkdirSync(join(root, 'apps/web/app/nightly'), { recursive: true });
    writeFileSync(
      join(root, 'apps/web/app/nightly/jobs.ts'),
      [
        `import { job, t } from ${JSON.stringify(jobsEntry)};`,
        'export const nightly = job({',
        "  name: 'budget-nightly',",
        "  tenant: 'none',",
        '  input: t.object({}),',
        "  idempotencyKey: () => 'nightly',",
        "  retry: { attempts: 3, backoff: 'fixed', delay: 1_000, jitter: false },",
        "  timeout: '2h',",
        '  run: () => Promise.resolve(),',
        '});',
        '',
      ].join('\n'),
    );
    const step = VERIFY_STEPS.find((candidate) => candidate.name === 'manifest');
    const outcome = await step?.run({
      root,
      runner: async (argv) => ({
        command: argv,
        code: 0,
        ok: true,
        stdout: '',
        stderr: '',
        durationMs: 0,
      }),
    });
    const finding = outcome?.findings.find((one) => one.code === 'X_JOB_OUTLASTS_DRAIN');
    expect(outcome?.ok).toBe(false);
    expect(finding?.cause).toContain('budget-nightly');
    expect(finding?.cause).toContain('7200000');
    expect(finding?.fix).toContain('workerRetireMs: 7200000');
  }, 30_000);
});
