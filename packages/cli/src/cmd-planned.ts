// The commands the design docs specify and this build does not yet implement. They are in the
// registry on purpose: `x cache bust` exiting X_CLI_UNKNOWN_COMMAND says "you typed something that
// does not exist", which is false and sends an agent looking for a typo. X_NOT_IMPLEMENTED plus a
// fix naming the closest shipped command says the true thing, and `x help` lists them honestly.

import type { CliCommand } from './command';
import { CliNotImplementedError } from './errors';
import type { CommandResult } from './output';
import type { CommandSpec } from './parse';

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
export const PLANNED_COMMANDS: readonly PlannedCommand[] = [
  {
    name: 'cache',
    summary: 'the tag graph, targeted eviction, hit stats',
    usage: 'x cache [graph|bust <tag>|clear|stats] [--json]',
    subcommands: ['graph', 'bust', 'clear', 'stats'],
    fix: 'x dev   # then the cache panel at /_x',
  },
  {
    name: 'branch',
    summary: 'copy-on-write branch environments with a preview URL',
    usage: 'x branch [<name>|rm <name>] [--json]',
    fix: 'x db branch ls --json   # the database half: ls, create <name>, drop <name>',
  },
  {
    name: 'status',
    summary: 'role health and the build-ID distribution of connected clients',
    usage: 'x status [--json]',
    fix: 'x doctor --json',
  },
  {
    name: 'upgrade',
    summary: 'move every @ultimat3/* in lockstep, with codemods',
    usage: 'x upgrade [--dry-run] [--json]',
    fix: 'bun update --latest && x verify',
  },
  {
    name: 'logs',
    summary: 'structured logs and OTel spans, filterable',
    usage: 'x logs tail [--json]',
    subcommands: ['tail'],
    fix: 'x dev   # then the timeline panel at /_x',
  },
  {
    name: 'token',
    summary: 'create MCP tokens and grant scopes',
    usage: 'x token [create --scopes <s>|grant <scope>] [--json]',
    subcommands: ['create', 'grant'],
    fix: 'x mcp serve --help   # the scopes this build serves',
  },
  {
    name: 'ai',
    summary: 'eval scores, semantic-cache stats, vector reindex',
    usage: 'x ai [eval <name>|cache|reindex] [--json]',
    subcommands: ['eval', 'cache', 'reindex'],
    fix: 'x test eval --json   # every eval, scored against its committed baseline',
  },
  // `registerCurrency()` ships `As of 2026-08`, and this row is deliberately NOT deleted with it.
  // What is planned is a GENERATOR — the one thing a process that exits can contribute, since a
  // registration has to land in the app's own source to survive the run — and a generator that
  // emits the one call is not a second path any more than `x g route` is a second way to declare a
  // route (axiom 1). The whole table is shaped this way: `x status` beside `x doctor`, `x cache`
  // beside the `/_x` panel. What changed is only that the `fix:` is now true.
  {
    name: 'money',
    summary: 'extend the currency table',
    usage: 'x money add-currency <ISO> --exponent <n> [--json]',
    subcommands: ['add-currency'],
    fix: "x errors explain X_CURRENCY_UNKNOWN --json   # extend it in code: registerCurrency({ code: 'GHS', exponent: 2, name: 'Ghana Cedi' }) at boot",
  },
  {
    name: 'config',
    summary: 'the resolved app.config.ts, defaults included',
    usage: 'x config show [--json]',
    subcommands: ['show'],
    fix: 'x manifest --json   # the facts the resolved config produced',
  },
];

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
 * above, one level down: `x db studio` stays in `x db`'s subcommand list, so the parser accepts it
 * and `x help db` still lists it, and it exits X_NOT_IMPLEMENTED naming what to run instead.
 *
 * `studio` is here because the migration engine is `@ultimat3/db`'s and only that. It used to
 * shell out to `bunx drizzle-kit studio` — a second schema tool, fetched unpinned at run time,
 * declared in no `package.json` — while every other `x db` subcommand went through the framework's
 * own ledger. One subcommand is not worth a second engine.
 */
export const PLANNED_SUBCOMMANDS: readonly PlannedSubcommand[] = [
  {
    command: 'db',
    subcommand: 'studio',
    fix: 'x dev   # then the db panel at /_x: schema, rows, and a guarded SQL console',
  },
];

/**
 * Thrown by the owning command, so the subcommand fails exactly where it would have run. Returns
 * the error rather than throwing it, because a `run` that throws synchronously escapes the
 * promise its signature promises — the caller does `throw plannedSubcommand(...)`.
 */
export function plannedSubcommand(command: string, subcommand: string): CliNotImplementedError {
  const planned = PLANNED_SUBCOMMANDS.find(
    (entry) => entry.command === command && entry.subcommand === subcommand,
  );
  return new CliNotImplementedError({
    feature: `x ${command} ${subcommand}`,
    // `x help <command>`, not `x <command> --help`: for a command that declares subcommands and no
    // default, the latter is refused by the parser before help is ever rendered.
    fix: planned?.fix ?? `x help ${command}`,
  });
}

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
    throw new CliNotImplementedError({
      feature: `x ${planned.name}`,
      fix: planned.fix,
    });
  },
});

export const plannedCommands = (): readonly CliCommand[] => PLANNED_COMMANDS.map(toCommand);
