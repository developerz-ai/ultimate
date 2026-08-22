// The one place the CLI does I/O: parse, run, render, exit. Commands return data; this decides
// whether it is printed as text or JSON and what the process exits with. Errors take the same
// path as results, so a failure is machine-readable exactly like a success.

import { isAbsolute, resolve } from 'node:path';
import { setLogStream } from '@ultimat3/core';
import { requireAppRoot, requireBunVersion } from './app-root';
import { createHelpCommand } from './cmd-help';
import { plannedCommandFor } from './cmd-planned';
import type { CommandContext } from './command';
import { CliNotImplementedError, UnknownCommandError } from './errors';
import type { Runner } from './exec';
import { exec } from './exec';
import type { CommandResult } from './output';
import { exitCodeFor, findingFrom, render } from './output';
import type { ParsedArgs } from './parse';
import { parseArgs, wantsJson } from './parse';
import { commandFor, SPECS } from './registry';

export interface DispatchOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bunVersion: string;
  readonly runner?: Runner;
  readonly write: (line: string) => void;
  /**
   * Where a result declaring `stream: 'stderr'` goes. Optional, and it falls back to `write`: an
   * embedding caller that supplies one sink must still SEE the line, and `create-ultimate`'s entry
   * point — which can only ever reach `x new` — would otherwise have to declare a sink for a case
   * it cannot produce. `bin.ts` passes the real fd 2.
   */
  readonly writeError?: (line: string) => void;
}

/**
 * Which sink a result is written to. One function because `dispatch` writes in five places — the
 * version refusal, the parse failure, the unknown command, the result and the catch — and a rule
 * about fd 1 that four of them apply is not a rule.
 */
export const sinkFor = (
  result: CommandResult,
  options: Pick<DispatchOptions, 'write' | 'writeError'>,
): ((line: string) => void) =>
  result.stream === 'stderr' ? (options.writeError ?? options.write) : options.write;

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
  // Its own branch, ahead of the parse: an unsupported Bun is a fact about the environment and
  // outranks anything argv says, including the planned pre-empt below.
  try {
    requireBunVersion(options.bunVersion);
  } catch (error) {
    const failure = errorResult('x', error);
    sinkFor(failure, options)(render(failure, wantsJson(options.argv)));
    return 1;
  }

  let args: ParsedArgs;
  try {
    args = parseArgs(options.argv, SPECS);
  } catch (error) {
    // A PLANNED command is not built, so every invocation of one must say that and nothing else.
    // The parser refuses an undeclared flag before any `run` is reached and a planned command
    // declares only the four globals, so `x logs tail --follow` reported X_CLI_BAD_FLAG — a flag
    // list for a command that does not exist yet — while `x logs tail` reported the honest
    // X_NOT_IMPLEMENTED with a runnable fix. Substituted here rather than in `parse.ts`, which is
    // pure and knows nothing about what a command means; the precedent is the help swap below.
    const planned = plannedCommandFor(commandFor(options.argv[0] ?? '')?.spec.name);
    const failure =
      planned === undefined
        ? error
        : new CliNotImplementedError({ feature: `x ${planned.name}`, fix: planned.fix });
    // `wantsJson`, not `includes('--json')`: a typo'd flag or a typo'd command is exactly the case
    // an agent hits while always passing `-j`, and the short form rendered prose it then parsed.
    const result = errorResult(planned?.name ?? 'x', failure);
    sinkFor(result, options)(render(result, wantsJson(options.argv)));
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
    sinkFor(result, options)(render(result, args.json));
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
    // `--json` means fd 1 carries ONE document, and every command that boots an app logs through
    // core's module-scope `logger`, whose default writer is stdout: `x db migrate --json` printed
    // `ultimate migrate applied` and then the command's own object, so `json.load` on the output
    // of a command whose whole contract is `--json` raised on the second. Decided HERE, once, for
    // all thirty commands — a rule each booting command had to remember is a rule the next one
    // forgets. A server's stdout stays its log stream; this is about the CLI process only.
    // Set on EVERY dispatch, both ways: the stream is process-wide state, so `if (args.json)`
    // alone left a JSON run's `stderr` in place for the next non-JSON one — one `x` process
    // dispatching twice (the MCP host, a test, an embedding caller) lost its boot logs off stdout.
    setLogStream(args.json ? 'stderr' : 'stdout');
    // The reader `CommandSpec.requiresApp` never had. Its doc said "the dispatcher enforces it" and
    // `dispatch` did not read the field at all: the guarantee held only because all 17 declaring
    // commands happen to call `requireAppRoot` themselves, so a new command that declares it and
    // forgets the call ran outside an app with no refusal. Each of those 17 calls stays — they are
    // what hands a command the root it works in, and several name a subcommand this cannot see
    // (`env init`, `secrets set`) — but the DECLARATION is now what decides, ahead of any check a
    // command makes about its own arguments. `--help` is exempt because `target` is then the help
    // command, which declares nothing: usage for a command must be readable from anywhere.
    if (target.spec.requiresApp === true) requireAppRoot(target.spec.name, ctx.cwd);
    const result = await target.run(ctx);
    sinkFor(result, options)(render(result, args.json, args.flags.get('verbose') === true));
    // `x dev` and `x mcp serve --transport http` are still listening here: report first, so the
    // url is on stdout the moment it is reachable, then stay in the process until the drain that
    // stops them. Without this the exit code below is what takes the server down.
    await result.hold?.();
    return exitCodeFor(result);
  } catch (error) {
    const result = errorResult(args.command, error);
    sinkFor(result, options)(render(result, args.json));
    return 1;
  }
}
