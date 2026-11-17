// The commands the design docs specify and this build does not yet implement. They are in the
// registry on purpose: `x branch` exiting X_CLI_UNKNOWN_COMMAND says "you typed something that
// does not exist", which is false and sends an agent looking for a typo. X_NOT_IMPLEMENTED plus a
// fix naming the closest shipped command says the true thing, and `x help` lists them honestly.

import { NotImplementedError } from '@ultimat3/core';
import type { CliCommand } from './command';
import type { CommandResult } from './output';
import type { CommandSpec } from './parse';
import { quoteArg } from './shell-quote';

export interface PlannedCommand {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  readonly subcommands?: readonly string[];
  /** Runnable today, and closer to the answer than nothing. Never a doc link. */
  readonly fix: string;
}

/**
 * `wiki/CLI-Reference.md`'s planned table, verbatim in shape. Every `fix` names a command this
 * build actually ships — a fix line pointing at another unbuilt command is the failure mode this
 * table exists to close, and `cmd-planned.test.ts` asserts the whole set against the registry.
 */
// Empty `As of 2026-11-16` (plan 101b slice 13): `x branch`, `x ai` and `x money` left the
// registry, each with its decision and extension point in wiki/Known-Gaps.md, and the parser now
// refuses each with `X_CLI_UNKNOWN_COMMAND`. Finished means this list is empty, not that every idea
// was built; a row returns only with a plan that builds it.
export const PLANNED_COMMANDS: readonly PlannedCommand[] = [];

/**
 * The planned command a resolved command NAME belongs to, if any. Exported for `dispatch.ts`'s
 * parse-failure branch: the parser refuses an undeclared flag before any `run` is reached, and a
 * planned command declares only the four global flags — so `x logs tail --follow` answered
 * X_CLI_BAD_FLAG listing "known: json, help, cwd, verbose", a flag set belonging to a command that
 * does not exist yet, while `x logs tail` answered the honest X_NOT_IMPLEMENTED one invocation away.
 *
 * Takes the name `commandFor` resolved, never the raw word: aliases are that function's business
 * and a second matcher here would be a second answer to "which command did they type".
 */
export const plannedCommandFor = (name: string | undefined): PlannedCommand | undefined =>
  PLANNED_COMMANDS.find((planned) => planned.name === name);

export interface PlannedSubcommand {
  readonly command: string;
  readonly subcommand: string;
  /** Runnable today, and closer to the answer than nothing. Never a doc link. */
  readonly fix: string;
}

/**
 * A subcommand of a shipped command that this build does not implement. Same promise as the table
 * above, one level down: the subcommand stays in its command's list, so the parser accepts it and
 * `x help <command>` lists it, and it exits X_NOT_IMPLEMENTED naming what to run instead.
 *
 * Empty, `As of 2026-11-15` (plan 101-finished-and-self-maintained G6). `x token grant`,
 * `x cache stats`, `x db studio` and `x jobs drain` left the registry rather than stay planned:
 * a key's scopes are never widened, hit rates are aggregated by no process, the `/_x` db panel is
 * the one schema browser, and Postgres is the one durable job driver. Each reason is its row in
 * `wiki/Known-Gaps.md`; the parser now refuses each, with the same exit code.
 */
export const PLANNED_SUBCOMMANDS: readonly PlannedSubcommand[] = [];

/**
 * Thrown by the owning command, so the subcommand fails exactly where it would have run. Returns
 * the error rather than throwing it, because a `run` that throws synchronously escapes the
 * promise its signature promises — the caller does `throw plannedSubcommand(...)`.
 */
export function plannedSubcommand(command: string, subcommand: string): NotImplementedError {
  const planned = PLANNED_SUBCOMMANDS.find(
    (entry) => entry.command === command && entry.subcommand === subcommand,
  );
  return new NotImplementedError({
    cause: `x ${command} ${subcommand} is not implemented in this build`,
    // `x help <command>`, not `x <command> --help`: for a command that declares subcommands and no
    // default, the latter is refused by the parser before help is ever rendered.
    fix: planned?.fix ?? `x help ${quoteArg(command.split(' '))}`,
  });
}

/**
 * What every invocation of a planned command answers — its `run`, and the dispatcher when the
 * parser refused a flag before any `run` was reached. One builder, so the two cannot drift.
 */
export const plannedCommandError = (planned: PlannedCommand): NotImplementedError =>
  new NotImplementedError({
    cause: `x ${planned.name} is not implemented in this build`,
    fix: planned.fix,
  });

const specFor = (planned: PlannedCommand): CommandSpec => ({
  name: planned.name,
  summary: `${planned.summary} (planned)`,
  usage: planned.usage,
  // A planned command answers X_NOT_IMPLEMENTED however it is invoked, so the bare form must
  // reach its `run` rather than being refused for a subcommand that does not exist yet.
  ...(planned.subcommands === undefined
    ? {}
    : { subcommands: planned.subcommands, defaultSubcommand: planned.subcommands[0] }),
});

/**
 * Throws rather than returning a failed `CommandResult`: `dispatch` renders a thrown
 * `UltimateError` through the same 3-line contract and the same `--json` shape, so a planned
 * command reads byte-identically to any other typed failure.
 */
const toCommand = (planned: PlannedCommand): CliCommand => ({
  spec: specFor(planned),
  // `async` is load-bearing: a synchronous throw would escape every caller that awaits the
  // promise this signature promises, including the dispatcher's own error path.
  async run(): Promise<CommandResult> {
    throw plannedCommandError(planned);
  },
});

export const plannedCommands = (): readonly CliCommand[] => PLANNED_COMMANDS.map(toCommand);
