// The two tables that say which commands the design specifies and this build does not ship. Both
// are empty, and `bun run scripts/finished.ts` is red the moment either holds a row: a command
// either ships or is refused by the parser as unknown, with its decision in wiki/Known-Gaps.md.

import { NotImplementedError } from '@ultimat3/core';
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
 * Empty `As of 2026-11-16` (plan 101b slice 13): `x branch`, `x ai` and `x money` left the registry,
 * each with its decision and extension point in wiki/Known-Gaps.md, and the parser refuses each
 * with `X_CLI_UNKNOWN_COMMAND`. Read by the citation checks (`fix-command.ts`) and the finished row.
 */
export const PLANNED_COMMANDS: readonly PlannedCommand[] = [];

export interface PlannedSubcommand {
  readonly command: string;
  readonly subcommand: string;
  /** Runnable today, and closer to the answer than nothing. Never a doc link. */
  readonly fix: string;
}

/**
 * Empty `As of 2026-11-15` (plan 101-finished-and-self-maintained G6). `x token grant`,
 * `x cache stats`, `x db studio` and `x jobs drain` left the registry rather than stay planned;
 * each reason is its row in `wiki/Known-Gaps.md`.
 */
export const PLANNED_SUBCOMMANDS: readonly PlannedSubcommand[] = [];

/**
 * @deprecated No command calls this: a subcommand a command lacks is `X_CLI_UNKNOWN_COMMAND`. It is
 * a public export, so it stays until a major may remove it (`wiki/Stability.md`, Deprecation).
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
