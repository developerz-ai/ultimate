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

export const ok = (
  command: string,
  summary: string,
  extra: Partial<CommandResult> = {},
): CommandResult => ({ ok: true, command, summary, ...extra });

export const failed = (
  command: string,
  summary: string,
  extra: Partial<CommandResult> = {},
): CommandResult => ({ ok: false, command, summary, ...extra });
