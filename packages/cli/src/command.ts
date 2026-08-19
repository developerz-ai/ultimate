// The shape every command implements. A command is a spec (for parsing and help) plus a pure-ish
// `run` that returns a `CommandResult` — it never writes to stdout and never calls process.exit,
// so the dispatcher owns rendering and the exit code, and every command is directly testable.

import type { Runner } from './exec';
import type { CommandResult } from './output';
import type { CommandSpec, ParsedArgs } from './parse';

export interface CommandContext {
  readonly args: ParsedArgs;
  /** Already resolved: `--cwd` applied, app root not yet required. */
  readonly cwd: string;
  readonly runner: Runner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bunVersion: string;
}

export interface CliCommand {
  readonly spec: CommandSpec;
  run(ctx: CommandContext): Promise<CommandResult>;
}

/**
 * `ok` is written AFTER the spread in both helpers, and that order is the whole contract: the
 * function's NAME is the verdict, and `extra` may carry every other field. Spread last, a caller
 * passing `{ ok: true }` to `failed()` got a result `exitCodeFor` exits 0 on while its own summary
 * says it failed — a green CI over a red command. `command` and `summary` stay before the spread
 * on purpose: those are arguments a caller may legitimately refine, and only the verdict is the
 * helper's to keep.
 */
export const ok = (
  command: string,
  summary: string,
  extra: Partial<CommandResult> = {},
): CommandResult => ({ command, summary, ...extra, ok: true });

export const failed = (
  command: string,
  summary: string,
  extra: Partial<CommandResult> = {},
): CommandResult => ({ command, summary, ...extra, ok: false });
