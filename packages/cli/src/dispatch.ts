// The one place the CLI does I/O: parse, run, render, exit. Commands return data; this decides
// whether it is printed as text or JSON and what the process exits with. Errors take the same
// path as results, so a failure is machine-readable exactly like a success.

import { isAbsolute, resolve } from 'node:path';
import { requireBunVersion } from './app-root';
import { createHelpCommand } from './cmd-help';
import type { CommandContext } from './command';
import { UnknownCommandError } from './errors';
import type { Runner } from './exec';
import { exec } from './exec';
import type { CommandResult } from './output';
import { exitCodeFor, findingFrom, render } from './output';
import type { ParsedArgs } from './parse';
import { parseArgs } from './parse';
import { commandFor, SPECS } from './registry';

export interface DispatchOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bunVersion: string;
  readonly runner?: Runner;
  readonly write: (line: string) => void;
}

const resolveCwd = (cwd: string, flag: string | undefined): string => {
  if (flag === undefined) return cwd;
  return isAbsolute(flag) ? flag : resolve(cwd, flag);
};

const errorResult = (command: string, error: unknown): CommandResult => ({
  ok: false,
  command,
  summary: 'command failed',
  findings: [findingFrom(error)],
  exitCode: 1,
});

/**
 * Returns the exit code instead of calling process.exit, so a test can drive the whole CLI end to
 * end without terminating the test runner.
 */
export async function dispatch(options: DispatchOptions): Promise<number> {
  let args: ParsedArgs;
  try {
    requireBunVersion(options.bunVersion);
    args = parseArgs(options.argv, SPECS);
  } catch (error) {
    const result = errorResult('x', error);
    options.write(render(result, options.argv.includes('--json')));
    return 1;
  }

  const command = commandFor(args.command);
  if (command === undefined) {
    const result = errorResult(
      args.command,
      new UnknownCommandError({
        path: args.command,
        known: SPECS.map((spec) => spec.name),
      }),
    );
    options.write(render(result, args.json));
    return 1;
  }

  // `--help` on any command is answered by help itself, never by the command's own branch.
  const target = args.help ? createHelpCommand(() => SPECS) : command;
  const helpArgs: ParsedArgs = args.help
    ? { ...args, command: 'help', positionals: [args.command] }
    : args;

  const ctx: CommandContext = {
    args: helpArgs,
    cwd: resolveCwd(
      options.cwd,
      typeof args.flags.get('cwd') === 'string' ? String(args.flags.get('cwd')) : undefined,
    ),
    runner: options.runner ?? exec,
    env: options.env,
    bunVersion: options.bunVersion,
  };

  try {
    const result = await target.run(ctx);
    options.write(render(result, args.json, args.flags.get('verbose') === true));
    return exitCodeFor(result);
  } catch (error) {
    const result = errorResult(args.command, error);
    options.write(render(result, args.json));
    return 1;
  }
}
