// `x verify` — the contract. Every check is a named step with its own pass/fail and duration, the
// same list in the terminal and in --json, and a non-zero exit if any step fails. Green means
// shippable (axiom 5); there is no second checklist and no CI-only step.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import { checkBudgets, readBuildStats } from './budgets';
import type { CliCommand, CommandContext } from './command';
import { checkDrift } from './drift';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import { scanApp } from './manifest-scan';
import { msg } from './messages';
import type { OpenApiDocument } from './openapi';
import { buildOpenApi, diffOpenApi } from './openapi';
import type { CommandResult, Finding, StepResult } from './output';
import { flagList } from './parse';
import { checkAppBoundaries } from './surfaces';

export interface VerifyContext {
  readonly root: string;
  readonly runner: Runner;
}

export interface StepOutcome {
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  readonly output?: string;
}

export interface VerifyStep {
  readonly name: string;
  readonly summary: string;
  /** Returns false to record the step as skipped rather than passed. */
  applies?(ctx: VerifyContext): Promise<boolean>;
  run(ctx: VerifyContext): Promise<StepOutcome>;
}

const passed: StepOutcome = { ok: true, findings: [] };

function fromExec(result: ExecResult, finding: Omit<Finding, 'docs'>): StepOutcome {
  if (result.ok) return { ok: true, findings: [], output: execOutput(result) };
  return {
    ok: false,
    findings: [{ ...finding, docs: `https://ultimate.dev/errors/${finding.code}` }],
    output: execOutput(result),
  };
}

const fromFindings = (findings: readonly Finding[]): StepOutcome => ({
  ok: findings.length === 0,
  findings,
});

/** One `bun test` invocation per test type; the type helpers prefix their describe blocks. */
function testStep(name: string, requires?: string): VerifyStep {
  const step: VerifyStep = {
    name,
    summary: `${name} tests`,
    async run(ctx) {
      const result = await ctx.runner(['bun', 'test', '--test-name-pattern', `${name} · `], {
        cwd: ctx.root,
      });
      return fromExec(result, {
        code: 'X_TEST_FAILED',
        cause: `one or more ${name} tests failed`,
        fix: `bun test --test-name-pattern "${name} · "`,
      });
    },
  };
  if (requires === undefined) return step;
  return {
    ...step,
    applies: async (ctx) => existsSync(join(ctx.root, requires)),
  };
}

const readOpenApi = async (root: string): Promise<OpenApiDocument | undefined> => {
  const path = join(root, 'openapi.json');
  if (!existsSync(path)) return undefined;
  return (await Bun.file(path).json()) as OpenApiDocument;
};

/** The nine checks of the contract, expanded so each test type reports on its own line. */
export const VERIFY_STEPS: readonly VerifyStep[] = [
  {
    name: 'typecheck',
    summary: 'tsc across every workspace',
    async run(ctx) {
      const result = await ctx.runner(['bunx', 'tsc', '-b', '--pretty', 'false'], {
        cwd: ctx.root,
      });
      return fromExec(result, {
        code: 'X_TYPECHECK_FAILED',
        cause: 'the project does not typecheck',
        fix: 'bunx tsc -b --pretty false',
      });
    },
  },
  {
    name: 'lint',
    summary: 'biome: no any, no default exports, no raw colours',
    async run(ctx) {
      const result = await ctx.runner(['bunx', 'biome', 'check', '.'], { cwd: ctx.root });
      return fromExec(result, {
        code: 'X_LINT_FAILED',
        cause: 'biome reported problems',
        fix: 'bunx biome check --write .',
      });
    },
  },
  {
    name: 'boundaries',
    summary: 'surface and layer imports',
    run: async (ctx) => fromFindings(await checkAppBoundaries(ctx.root)),
  },
  testStep('unit'),
  testStep('contract'),
  testStep('live'),
  testStep('job'),
  { ...testStep('e2e', 'e2e'), summary: 'playwright, incl. offline + SW update' },
  { ...testStep('eval', 'evals'), summary: 'LLM output scoring against thresholds' },
  {
    name: 'drift',
    summary: 'schema vs migrations',
    run: async (ctx) => fromFindings(await checkDrift(ctx.root)),
  },
  {
    name: 'contract-diff',
    summary: 'published actions vs openapi.json',
    applies: async (ctx) => existsSync(join(ctx.root, 'openapi.json')),
    async run(ctx) {
      const committed = await readOpenApi(ctx.root);
      if (committed === undefined) return passed;
      const manifest = await scanApp({ root: ctx.root });
      const current = buildOpenApi(manifest, committed.info.version);
      return fromFindings(diffOpenApi(committed, current, { versionBumped: false }));
    },
  },
  {
    name: 'budgets',
    summary: 'per-route JS bytes and LCP',
    async run(ctx) {
      const stats = await readBuildStats(ctx.root);
      if (stats === undefined) return passed;
      const manifest = await scanApp({ root: ctx.root });
      return fromFindings(checkBudgets(manifest, stats));
    },
  },
  {
    name: 'manifest',
    summary: 'x.manifest.json freshness',
    applies: async (ctx) => existsSync(join(ctx.root, 'x.manifest.json')),
    async run(ctx) {
      const committed = (await Bun.file(join(ctx.root, 'x.manifest.json')).json()) as {
        buildId?: string;
      };
      const current = await scanApp({ root: ctx.root });
      if (committed.buildId === current.buildId) return passed;
      return fromFindings([
        {
          code: 'X_MANIFEST_STALE',
          cause: `x.manifest.json records build ${committed.buildId ?? 'none'}, the code produces ${current.buildId}`,
          fix: 'x manifest',
          docs: 'https://ultimate.dev/errors/X_MANIFEST_STALE',
          at: 'x.manifest.json',
        },
      ]);
    },
  },
];

export interface VerifyOptions {
  readonly only?: readonly string[];
  readonly skip?: readonly string[];
}

const selected = (steps: readonly VerifyStep[], options: VerifyOptions): readonly VerifyStep[] => {
  const only = options.only ?? [];
  const skip = options.skip ?? [];
  return steps.filter(
    (step) => (only.length === 0 || only.includes(step.name)) && !skip.includes(step.name),
  );
};

/**
 * Run steps in order, never bailing early: an agent fixing three things at once needs all three
 * findings from one run, not one per round-trip.
 */
export async function runVerify(
  steps: readonly VerifyStep[],
  ctx: VerifyContext,
  options: VerifyOptions = {},
): Promise<CommandResult> {
  const chosen = selected(steps, options);
  const results: StepResult[] = [];
  for (const step of chosen) {
    const applies = step.applies === undefined ? true : await step.applies(ctx);
    if (!applies) {
      results.push({ name: step.name, ok: true, durationMs: 0, skipped: true, findings: [] });
      continue;
    }
    const started = performance.now();
    const outcome = await step.run(ctx).catch(
      (error: unknown): StepOutcome => ({
        ok: false,
        findings: [findingOf(error, step.name)],
      }),
    );
    results.push({
      name: step.name,
      ok: outcome.ok,
      durationMs: Math.round(performance.now() - started),
      findings: outcome.findings,
      ...(outcome.output === undefined ? {} : { output: outcome.output }),
    });
  }
  const failedSteps = results.filter((step) => !step.ok).map((step) => step.name);
  const totalMs = results.reduce((sum, step) => sum + step.durationMs, 0);
  return {
    ok: failedSteps.length === 0,
    command: 'verify',
    summary:
      failedSteps.length === 0
        ? msg('cli.verify.pass', { count: results.length, ms: totalMs })
        : msg('cli.verify.fail', { failed: failedSteps.length, count: results.length }),
    steps: results,
    data: { failed: failedSteps, durationMs: totalMs },
    exitCode: failedSteps.length === 0 ? 0 : 1,
  };
}

function findingOf(error: unknown, step: string): Finding {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    code: 'X_VERIFY_FAILED',
    cause: `step "${step}" threw: ${cause}`,
    fix: `x verify --only ${step} --json`,
    docs: 'https://ultimate.dev/errors/X_VERIFY_FAILED',
  };
}

export const verifyCommand: CliCommand = {
  spec: {
    name: 'verify',
    summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
    usage: 'x verify [--only step,step] [--skip step] [--json]',
    requiresApp: true,
    flags: [
      { name: 'only', type: 'string', summary: 'comma-separated step names to run' },
      { name: 'skip', type: 'string', summary: 'comma-separated step names to skip' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('verify', ctx.cwd).dir;
    return runVerify(
      VERIFY_STEPS,
      { root, runner: ctx.runner },
      { only: flagList(ctx.args, 'only'), skip: flagList(ctx.args, 'skip') },
    );
  },
};

export const verifyStepNames = (): readonly string[] => VERIFY_STEPS.map((step) => step.name);
