// `x verify` — the contract. Every check is a named step with its own pass/fail and duration, the
// same list in the terminal and in --json, and a non-zero exit if any step fails. Green means
// shippable (axiom 5): one step list, no second checklist, no CI-only step, and no way to narrow
// the run — `--only` and `--skip` would make "green" mean whatever the caller chose.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '@ultimat3/manifest';
import {
  AGENTS_MD_FILENAME,
  assertNoDrift,
  MANIFEST_FILENAME,
  verifyContract,
} from '@ultimat3/manifest';
import { checkAgentsMd } from './app-agents-md';
import { checkAppBoundaries } from './app-boundaries';
import { envExampleFindings } from './app-env';
import { appManifest, readAppManifest } from './app-manifest';
import { OPENAPI_FILE, openApiJson } from './app-openapi';
import { APP_CONFIG_FILE, requireAppRoot } from './app-root';
import { checkBudgets, readBuildStats } from './budgets';
import type { CliCommand, CommandContext } from './command';
import { checkDestructiveMigrations } from './db-destructive';
import { checkDocumentStyles, documentSurfaces } from './document-styles';
import { checkSourceDrift } from './drift';
import { checkErrorFixes } from './error-contract';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult, Finding, StepResult } from './output';
import { findingFrom } from './output';
import type { ParsedArgs } from './parse';
import { flagString } from './parse';
import {
  floorProblemFindings,
  floorRequires,
  readVerifyFloor,
  vanishedSuiteFinding,
} from './verify-floor';
import type { StepOutcome, VerifyContext, VerifyStep, VerifyStepName } from './verify-step';
import { fromExec, fromFindings, hostFindings } from './verify-step';
import { TEST_STEPS } from './verify-tests';
import { checkFileSizes, checkPackageShape, hasWorkspacePackages } from './workspace-checks';

/** The whole contract, in cost order. Every check the framework knows how to make lives here. */
export const VERIFY_STEPS: readonly VerifyStep[] = [
  {
    name: 'typecheck',
    summary: 'tsc -b across every project the root references',
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
    summary: 'surface, layer and package-tier imports',
    run: async (ctx) =>
      fromFindings([
        ...(await checkAppBoundaries(ctx.root)),
        ...(await hostFindings(ctx, 'boundaries')),
      ]),
  },
  {
    name: 'filesize',
    summary: 'one file, one job',
    run: async (ctx) => fromFindings(await checkFileSizes(ctx.root)),
  },
  {
    name: 'package-shape',
    summary: 'every package ships the same contract files',
    applies: (ctx) => hasWorkspacePackages(ctx.root),
    run: async (ctx) => fromFindings(await checkPackageShape(ctx.root)),
  },
  {
    name: 'errors',
    summary: 'every X_* code has a runnable fix and a docs page',
    // The fix-line half runs anywhere source does. The docs half needs a reference page to check
    // against, and which file that is belongs to the host repo — hence `hostFindings`.
    run: async (ctx) =>
      fromFindings([...(await checkErrorFixes(ctx.root)), ...(await hostFindings(ctx, 'errors'))]),
  },
  ...TEST_STEPS,
  {
    name: 'drift',
    summary: 'schema source vs migrations, and every destructive statement declared',
    // Only an app owns migrations; a package monorepo's `packages/db` is the driver, not a schema.
    // Source, not database: the gate runs in CI with nothing listening, and the database half is
    // the post-migrate verification `runMigrations` performs where a connection is already open.
    //
    // The destructive rail rides here rather than becoming an eighteenth step because it asks this
    // step's own question — do the committed migrations still describe what the app is doing to its
    // schema? — off the same directory, in the same pass, with no database either.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    run: async (ctx) =>
      fromFindings([
        ...(await checkSourceDrift(ctx.root)),
        ...(await checkDestructiveMigrations(ctx.root)),
      ]),
  },
  {
    name: 'contract-diff',
    summary: 'the published contract vs the committed manifest',
    // Either file is a published contract on its own: `openapi.json` generates the typed client,
    // so gating on the manifest alone let a stale spec ship a wrong client unchecked.
    applies: async (ctx) =>
      existsSync(join(ctx.root, MANIFEST_FILENAME)) || existsSync(join(ctx.root, OPENAPI_FILE)),
    async run(ctx) {
      const committed = await readAppManifest(ctx.root);
      const { manifest, findings } = await appManifest(ctx.root);
      return fromFindings([
        ...findings,
        ...(committed === undefined ? [] : contractFindings(committed, manifest)),
        ...(await specFindings(ctx.root, manifest)),
      ]);
    },
  },
  {
    name: 'budgets',
    summary: 'per-route JS bytes and LCP, and the global style layer every document carries',
    // The global-style assertion rides here rather than becoming an eighteenth step, because this
    // step already asks the one question it asks: what does the document this build emits actually
    // contain? It is also the same app load — `appManifest` fills render's stylesheet registry on
    // its way through — so a separate step would pay for a second one to answer half a question.
    //
    // A repo with no `app.config.ts` is the framework monorepo, which renders no documents and has
    // no stylesheet registry to read; there is nothing for either half to weigh.
    applies: async (ctx) => existsSync(join(ctx.root, APP_CONFIG_FILE)),
    async run(ctx) {
      const stats = await readBuildStats(ctx.root);
      const { manifest } = await appManifest(ctx.root);
      return fromFindings([
        ...checkDocumentStyles(documentSurfaces()),
        ...(stats === undefined ? [] : checkBudgets(manifest, stats)),
      ]);
    },
  },
  {
    name: 'manifest',
    summary: 'the files an agent reads: generated facts, hand-written conventions, the env example',
    // No `applies`. The drift half has nothing to compare against until `x manifest` has run
    // once, and says so by finding nothing — but `AGENTS.md` is required of every repo the gate
    // runs in, so the step always has a question to answer and must never report as skipped.
    //
    // `.env.example` joins this step rather than becoming an eighteenth: the question is the same
    // one — "does a committed, generated file still describe the code?" — and the step list is the
    // definition of shippable, so it grows only when a genuinely new question needs asking.
    //
    // `x.verify.json` is here for that same question and no other: this step judges the floor
    // FILE, `runVerify` judges the suites against it. A name the gate does not run can never
    // vanish, so a typo in the floor covers nothing — which is the false green the floor exists to
    // close, and it is only visible if something reads the file for its own sake.
    async run(ctx) {
      const agents = await checkAgentsMd(ctx.root);
      const findings = [
        ...(await driftFindings(ctx.root)),
        ...(await envExampleFindings(ctx.root)),
        ...floorProblemFindings(await readVerifyFloor(ctx.root)),
        ...agents.findings,
        ...(await hostFindings(ctx, 'manifest')),
      ];
      // Warnings are not findings: `AGENTS.md` tabulating a route table is a smell a human
      // judges, not a build error. They ride in `output`, which `--json` carries verbatim.
      const output = agents.warnings.map((warning) => `${AGENTS_MD_FILENAME}: ${warning}`);
      return {
        ok: findings.length === 0,
        findings,
        ...(output.length === 0 ? {} : { output: output.join('\n') }),
      };
    },
  },
  {
    name: 'roadmap',
    summary: "every roadmap milestone's status marker matches what is actually on disk",
    // A generated app ships no `docs/idea/14-roadmap.md` — only the framework monorepo does, so
    // only a host that registers this check has anything for the step to verify.
    applies: async (ctx) => ctx.hostChecks?.roadmap !== undefined,
    run: async (ctx) => fromFindings(await hostFindings(ctx, 'roadmap')),
  },
];

/** `assertNoDrift` throws `X_MANIFEST_DRIFT`; a step reports, so the error becomes a finding. */
async function driftFindings(root: string): Promise<readonly Finding[]> {
  const path = join(root, MANIFEST_FILENAME);
  if (!existsSync(path)) return [];
  const { manifest, findings } = await appManifest(root);
  try {
    await assertNoDrift({ manifest, path });
    return findings;
  } catch (error) {
    return [...findings, { ...findingFrom(error), at: MANIFEST_FILENAME }];
  }
}

/** A breaking change is allowed — with a major bump. `verifyContract` is the one that decides. */
function contractFindings(before: Manifest, after: Manifest): readonly Finding[] {
  try {
    verifyContract({ before, after });
    return [];
  } catch (error) {
    return [{ ...findingFrom(error), at: MANIFEST_FILENAME }];
  }
}

/** The typed client is generated from `openapi.json`, so a stale spec ships a wrong client. */
async function specFindings(root: string, manifest: Manifest): Promise<readonly Finding[]> {
  const path = join(root, OPENAPI_FILE);
  if (!existsSync(path)) return [];
  if ((await Bun.file(path).text()) === openApiJson(manifest)) return [];
  return [
    {
      code: 'X_MANIFEST_STALE',
      cause: `${OPENAPI_FILE} does not match the actions the code registers`,
      fix: 'x manifest',
      docs: 'https://ultimate.dev/errors/X_MANIFEST_STALE',
      at: OPENAPI_FILE,
    },
  ];
}

/**
 * Run every step in order, never bailing early: an agent fixing three things at once needs all
 * three findings from one run, not one per round-trip.
 */
export async function runVerify(
  steps: readonly VerifyStep[],
  ctx: VerifyContext,
): Promise<CommandResult> {
  const floor = await readVerifyFloor(ctx.root);
  const results: StepResult[] = [];
  for (const step of steps) {
    const applies = step.applies === undefined ? true : await step.applies(ctx);
    if (!applies) {
      // A skip this repo already ruled out is not a skip. The step ran here before — the floor is
      // that claim, committed — so "nothing to check" now means the suite was deleted, and the
      // gate says so on the step's own line rather than counting one more thing not to worry
      // about. Recorded as failed and NOT as skipped, so every reader of a step table sees it:
      // the summary, `data.failed`, and the reference-app gate's own red list.
      const required = floorRequires(floor, step.name);
      results.push({
        name: step.name,
        ok: !required,
        durationMs: 0,
        skipped: !required,
        findings: required ? [vanishedSuiteFinding(step.name)] : [],
      });
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
      ...(outcome.workers === undefined ? {} : { workers: outcome.workers }),
    });
  }
  const failedSteps = results.filter((step) => !step.ok).map((step) => step.name);
  const skippedSteps = results.filter((step) => step.skipped === true).map((step) => step.name);
  const totalMs = results.reduce((sum, step) => sum + step.durationMs, 0);
  return {
    ok: failedSteps.length === 0,
    command: 'verify',
    summary: verifySummary({ results, failed: failedSteps, skipped: skippedSteps, totalMs }),
    steps: results,
    // `skipped` is a list beside `failed` and not a count, because the two answer the same kind of
    // question — *which* steps, not how many — and a caller ratcheting on coverage needs the names.
    data: { failed: failedSteps, skipped: skippedSteps, durationMs: totalMs },
    exitCode: failedSteps.length === 0 ? 0 : 1,
  };
}

/**
 * What the counts are allowed to claim. A step that does not apply is recorded green so the run
 * continues, and the summary counted it among the "all 17 steps passed" — so a repo whose `job`
 * and `eval` suites do not exist reported the same line as a repo where both ran. `--json` carried
 * the per-step flag all along; the one line every reader actually sees did not, which is how a
 * vacuous gate stayed invisible. It names the skipped steps, not just how many: "17/17" is worth
 * something only when the gap is visible in the same glance.
 */
function verifySummary(input: {
  readonly results: readonly StepResult[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly totalMs: number;
}): string {
  const params = {
    count: input.results.length,
    passed: input.results.filter((step) => step.ok && step.skipped !== true).length,
    failed: input.failed.length,
    skipped: input.skipped.length,
    names: input.skipped.join(', '),
    ms: input.totalMs,
  };
  const clean = input.skipped.length === 0;
  if (input.failed.length === 0) {
    return msg(clean ? 'cli.verify.pass' : 'cli.verify.passSkipped', params);
  }
  return msg(clean ? 'cli.verify.fail' : 'cli.verify.failSkipped', params);
}

function findingOf(error: unknown, step: string): Finding {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    code: 'X_VERIFY_FAILED',
    cause: `step "${step}" threw: ${cause}`,
    fix: 'x verify --json',
    docs: 'https://ultimate.dev/errors/X_VERIFY_FAILED',
  };
}

export const verifyCommand: CliCommand = {
  spec: {
    name: 'verify',
    summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
    usage: 'x verify [--workers N] [--json]',
    requiresApp: true,
    // The only flag, and it is not `--only`/`--skip` in disguise: it changes how wide the test
    // steps spread, never which steps run. Every step still runs, so "green" still means the
    // same thing at `--workers 1` as at `--workers 8`.
    flags: [
      {
        name: 'workers',
        type: 'string',
        summary: 'test processes per parallel step (default: CPUs - 1, max 8)',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('verify', ctx.cwd).dir;
    const workers = readWorkers(ctx.args);
    return runVerify(VERIFY_STEPS, {
      root,
      runner: ctx.runner,
      ...(workers === undefined ? {} : { workers }),
    });
  },
};

/** `x test --workers` refuses the same values for the same reason; the message names this one. */
function readWorkers(args: ParsedArgs): number | undefined {
  const raw = flagString(args, 'workers');
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new BadFlagError({
      flag: 'workers',
      command: 'verify',
      reason: `expects an integer >= 1, got "${raw}"`,
      fix: 'x verify --workers 4',
    });
  }
  return value;
}

export const verifyStepNames = (): readonly VerifyStepName[] =>
  VERIFY_STEPS.map((step) => step.name);
