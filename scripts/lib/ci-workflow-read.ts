// The one reader of `.github/workflows/*.yml` the ci-workflow tests share: the slice of the
// GitHub Actions schema they assert on, the parse, and the small accessors every suite repeats.
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
