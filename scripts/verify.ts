#!/usr/bin/env bun
// The gate for the framework repo itself — the same named steps `x verify` runs for an app, so a
// contributor and a user see the same output. Green means shippable.
//
//   bun run scripts/verify.ts [--only lint,boundaries] [--skip test] [--json] [--verbose]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { checkBoundaries, collectSourceFiles, findingFor } from './boundaries';
import { flagBool, flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot, run } from './lib/run';
import type { Step, StepOutcome } from './lib/steps';
import { runSteps, stepLines } from './lib/steps';
import { listWorkspaces } from './lib/workspaces';

const HARD_LINE_CEILING = 500;

const fromRun = async (
  command: readonly string[],
  root: string,
  finding: Finding,
): Promise<StepOutcome> => {
  const result = await run(command, { cwd: root });
  return result.ok
    ? { ok: true, findings: [], output: result.output }
    : { ok: false, findings: [finding], output: result.output };
};

/** Files are the unit of review: one file, one job, hard ceiling ~500 lines. */
async function checkFileSizes(root: string): Promise<StepOutcome> {
  const findings: Finding[] = [];
  for (const pattern of ['packages/*/src/**/*.ts', 'scripts/**/*.ts']) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      const lines = (await Bun.file(join(root, path)).text()).split('\n').length;
      if (lines > HARD_LINE_CEILING) {
        findings.push({
          code: 'X_FILE_TOO_LONG',
          cause: `${path} is ${lines} lines, over the ${HARD_LINE_CEILING} line ceiling`,
          fix: 'split it: one file, one responsibility',
          at: path,
        });
      }
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Every framework package ships the same seven files; a missing one is a build error. */
async function checkPackageShape(root: string): Promise<StepOutcome> {
  const findings: Finding[] = [];
  for (const workspace of await listWorkspaces(root)) {
    for (const required of ['README.md', 'CLAUDE.md', 'tsconfig.json', 'src/index.ts']) {
      if (existsSync(join(workspace.path, required))) continue;
      findings.push({
        code: 'X_PACKAGE_SHAPE',
        cause: `${workspace.name} has no ${required}`,
        fix: `bun run scripts/new-package.ts ${workspace.dir} --tier ${workspace.tier} --only ${required}`,
        at: `packages/${workspace.dir}/${required}`,
      });
    }
  }
  return { ok: findings.length === 0, findings };
}

function stepsFor(root: string): readonly Step[] {
  return [
    {
      name: 'typecheck',
      summary: 'tsc -b across every package',
      run: () =>
        fromRun(['bunx', 'tsc', '-b', '--pretty', 'false'], root, {
          code: 'X_TYPECHECK_FAILED',
          cause: 'the workspace does not typecheck',
          fix: 'bunx tsc -b --pretty false',
        }),
    },
    {
      name: 'lint',
      summary: 'biome: no any, no default exports, formatting',
      run: () =>
        fromRun(['bunx', 'biome', 'check', '.'], root, {
          code: 'X_LINT_FAILED',
          cause: 'biome reported problems',
          fix: 'bunx biome check --write .',
        }),
    },
    {
      name: 'boundaries',
      summary: 'the tier table, enforced',
      run: async () => {
        const violations = checkBoundaries(await collectSourceFiles(root));
        return { ok: violations.length === 0, findings: violations.map(findingFor) };
      },
    },
    {
      name: 'test',
      summary: 'bun test across every package',
      // `bun run test`, not bare `bun test`, so this gate and CI run the same command.
      // The script's ignore patterns drop two kinds of file: the `e2e/` suites, which
      // bind a real socket and are opt-in (`bun test packages/http/e2e`); and the
      // dummy app's contract/live/job/eval suites, which request fixtures nothing in
      // the repo registers — 13 tests that have never passed anywhere. See #9.
      run: () =>
        fromRun(['bun', 'run', 'test'], root, {
          code: 'X_TEST_FAILED',
          cause: 'one or more tests failed',
          fix: 'bun run test',
        }),
    },
    { name: 'filesize', summary: 'one file, one job', run: () => checkFileSizes(root) },
    {
      name: 'package-shape',
      summary: 'every package ships the same files',
      run: () => checkPackageShape(root),
    },
    {
      name: 'manifest',
      summary: 'the framework manifest regenerates',
      run: () =>
        fromRun(['bun', 'run', 'scripts/manifest.ts', '--json'], root, {
          code: 'X_MANIFEST_STALE',
          cause: 'the framework manifest could not be generated',
          fix: 'bun run scripts/manifest.ts',
        }),
    },
  ];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const reports = await runSteps(stepsFor(root), {
    only: flagList(args, 'only'),
    skip: flagList(args, 'skip'),
  });
  const failed = reports.filter((step) => !step.ok);
  const totalMs = reports.reduce((sum, step) => sum + step.durationMs, 0);
  report(
    {
      ok: failed.length === 0,
      script: 'verify',
      summary:
        failed.length === 0
          ? `all ${reports.length} steps passed in ${totalMs}ms`
          : `${failed.length} of ${reports.length} steps failed`,
      findings: failed.flatMap((step) => step.findings),
      lines: stepLines(reports, flagBool(args, 'verbose')),
      data: { steps: reports.map(({ output: _output, ...rest }) => rest), durationMs: totalMs },
    },
    args.json,
  );
}
