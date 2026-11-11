// `tests.run` and `verify.run` as the shell runs them: `x test` and `x verify` themselves, through
// their own commands, with the environment the shell would have handed them. A second test path in
// the dev MCP server (a bare `bun test <filter>`) answered red for files `x test` ran green.

import { ENVIRONMENT_KEY } from '@ultimat3/core';
import type { TestRun, VerifyResult, VerifyStep } from '@ultimat3/mcp';
import { testCommand } from './cmd-test';
import { testSpec } from './cmd-test-spec';
import { verifyCommand } from './cmd-verify';
import { verifySpec } from './cmd-verify-spec';
import { BadFlagError } from './errors';
import type { ExecResult, Runner } from './exec';
import { testRunOf } from './mcp-test-run';
import { parseArgs } from './parse';

type Env = Readonly<Record<string, string | undefined>>;

export interface ShellRunInput {
  readonly root: string;
  /** The host's environment — after `declareDevEnvironment` may have written to it. */
  readonly env: Env;
  readonly runner: Runner;
  /**
   * Whether THIS process declared `ULTIMATE_ENV=development` (`declareDevEnvironment`). A shell
   * never has it, so neither may a child: inherited, it overrode the `NODE_ENV=test` every
   * `bun test` sets, and the app's tests seeded and connected as development.
   */
  readonly declared: boolean;
}

/** The env a shell would hand `x test`/`x verify`: the host's, less what the host declared. */
export const shellEnv = (input: ShellRunInput): Env =>
  input.declared ? { ...input.env, [ENVIRONMENT_KEY]: undefined } : input.env;

/**
 * Every child spawned with the declared key unset, unless the caller sets it itself. `exec.ts`
 * overlays `options.env` onto `Bun.env`, the very object `declareDevEnvironment` wrote to, so
 * handing the commands `shellEnv` alone would not reach their children.
 */
export function shellRunner(input: ShellRunInput): Runner {
  if (!input.declared) return input.runner;
  return (command, options) =>
    input.runner(command, { ...options, env: { [ENVIRONMENT_KEY]: undefined, ...options.env } });
}

/**
 * `x test`'s argv for a `tests.run` filter. A filter is a path substring; one starting with `-`
 * would be read as a flag of `x test`, so it is refused rather than forwarded.
 */
export function testRunArgs(filter: string | undefined): readonly string[] {
  if (filter === undefined) return ['test'];
  if (filter.trimStart().startsWith('-')) {
    throw new BadFlagError({
      flag: 'filter',
      command: 'mcp serve',
      reason: `test.run's filter "${filter}" starts with "-", which x test would read as its own flag`,
      fix: 'call test.run with a path filter such as packages/cli/src, or with no filter',
    });
  }
  return ['test', '--filter', filter];
}

const isBunTest = (result: ExecResult): boolean =>
  result.command[0] === 'bun' && result.command[1] === 'test';

/** Every `bun test` batch `x test` spawned, summed into the one answer the tool returns. */
export function sumRuns(results: readonly ExecResult[], durationMs: number): TestRun {
  const runs = results.filter(isBunTest).map(testRunOf);
  return {
    passed: runs.reduce((sum, run) => sum + run.passed, 0),
    failed: runs.reduce((sum, run) => sum + run.failed, 0),
    skipped: runs.reduce((sum, run) => sum + run.skipped, 0),
    durationMs,
    failures: runs.flatMap((run) => run.failures),
  };
}

/** `tests.run`: `x test --filter <filter>`, with each batch's output read back into counts. */
export async function shellTests(
  input: ShellRunInput,
  filter: string | undefined,
): Promise<TestRun> {
  const results: ExecResult[] = [];
  const runner = shellRunner(input);
  const started = performance.now();
  const outcome = await testCommand.run({
    args: parseArgs(testRunArgs(filter), [testSpec]),
    cwd: input.root,
    env: shellEnv(input),
    bunVersion: Bun.version,
    runner: async (command, options) => {
      const result = await runner(command, options);
      results.push(result);
      return result;
    },
  });
  const run = sumRuns(results, Math.round(performance.now() - started));
  // A red command with no red batch read (a batch the parser could not see) is still red.
  if (outcome.ok || run.failed > 0) return run;
  const failure = { test: 'x test', message: outcome.summary };
  return { ...run, failed: 1, failures: [failure] };
}

/** `verify.run`: `x verify [--only a,b]`, its steps projected onto the tool's shape. */
export async function shellVerify(
  input: ShellRunInput,
  only: readonly string[] | undefined,
): Promise<VerifyResult> {
  const argv = only === undefined ? ['verify'] : ['verify', '--only', only.join(',')];
  // A refused `--only` throws the command's own coded error, which the tool renders as one.
  const result = await verifyCommand.run({
    args: parseArgs(argv, [verifySpec]),
    cwd: input.root,
    env: shellEnv(input),
    bunVersion: Bun.version,
    runner: shellRunner(input),
  });
  return {
    ok: result.ok,
    steps: (result.steps ?? []).map((step): VerifyStep => {
      const detail = step.findings[0]?.cause;
      // exactOptionalPropertyTypes: omit `detail`, never hand over an explicit undefined.
      return detail === undefined
        ? { name: step.name, ok: step.ok }
        : { name: step.name, ok: step.ok, detail };
    }),
  };
}
