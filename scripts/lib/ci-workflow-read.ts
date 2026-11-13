// The one reader of `.github/workflows/*.yml` the ci-workflow tests share: the slice of the
// GitHub Actions schema they assert on, the parse, and the small accessors every suite repeats.
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
import { join } from 'node:path'; // why: Bun ships no path API.
import { repoRoot } from './run';

export interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly run?: string;
  readonly shell?: string;
  readonly 'working-directory'?: string;
  readonly 'continue-on-error'?: unknown;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, unknown>>;
}

export interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly 'runs-on'?: string;
  readonly 'timeout-minutes'?: number;
  readonly 'continue-on-error'?: unknown;
  readonly defaults?: { readonly run?: { readonly shell?: string } };
  readonly env?: Readonly<Record<string, string>>;
  readonly services?: unknown;
  readonly permissions?: unknown;
  readonly strategy?: {
    readonly 'fail-fast'?: boolean;
    readonly matrix?: Readonly<Record<string, unknown>>;
  };
  readonly steps?: readonly Step[];
}

export interface Workflow {
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: unknown };
  readonly env?: Readonly<Record<string, string>>;
  readonly jobs?: Readonly<Record<string, Job>>;
}

export const readWorkflow = async (path: string): Promise<Workflow> =>
  Bun.YAML.parse(await Bun.file(`${repoRoot()}/.github/workflows/${path}`).text()) as Workflow;

export const jobOf = (workflow: Workflow, name: string): Job => workflow.jobs?.[name] ?? {};

export const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** `${{ body }}`, spelled so the source holds no `${` — a workflow expression is not a template. */
export const expr = (body: string): string => ['$', '{{ ', body, ' }}'].join('');

const listOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const PLAN_TIMEOUT_MS = 60_000;

/**
 * The gate's matrix rows, READ BY RUNNING the `tested` job's `plan` step — the gate's matrix is
 * `fromJSON` of what it writes, so no static `matrix.include` exists to read. In bash, from the
 * root, with the step's env and a scratch `$RUNNER_TEMP` and `$GITHUB_OUTPUT`. A step that is gone
 * or fails answers no rows, which every reader's floor (`parts.length > 1`) refuses.
 */
export async function planRows(
  workflow: Workflow,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const step = (jobOf(workflow, 'tested').steps ?? []).find((one) => one.id === 'plan');
  const temp = await mkdtemp(join(tmpdir(), 'ci-workflow-plan-'));
  try {
    const output = join(temp, 'output');
    const env = { ...Bun.env, ...step?.env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output };
    const child = Bun.spawn(['bash', '-c', text(step?.run)], {
      cwd: repoRoot(),
      env,
      stdout: 'ignore',
      stderr: 'ignore',
      // `x verify plan` answers in about a second; a hung one must fail the suite, not stall it.
      timeout: PLAN_TIMEOUT_MS,
    });
    if ((await child.exited) !== 0 || !(await Bun.file(output).exists())) return [];
    const line = (await Bun.file(output).text()).split('\n').find((l) => l.startsWith('matrix='));
    const matrix: unknown = JSON.parse(line?.slice('matrix='.length) ?? '{}');
    return listOf(record(matrix)['include']).map(record);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
