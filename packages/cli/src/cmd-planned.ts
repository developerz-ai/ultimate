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
    name: 'policy',
    summary: 'which clause decided a permission, and why',
    usage: 'x policy [list|explain <permission>] [--json]',
    subcommands: ['list', 'explain'],
    fix: 'x manifest --json   # every permission, and the actions and queries that enforce it',
  },
  {
    name: 'tasks',
    summary: 'cron tasks, their timezone and their next run',
    usage: 'x tasks [list|show <name>] [--json]',
    subcommands: ['list', 'show'],
    fix: 'x manifest --json   # every task, its cron expression and its timezone',
  },
  {
    name: 'cache',
    summary: 'the tag graph, targeted eviction, hit stats',
    usage: 'x cache [graph|bust <tag>|clear|stats] [--json]',
    subcommands: ['graph', 'bust', 'clear', 'stats'],
    fix: 'x dev   # then the cache panel at /_x',
  },
  {
    name: 'i18n',
    summary: 'catalogs: add a locale, sync keys, check for gaps',
    usage: 'x i18n [add <locale>|sync <locale>|check] [--json]',
    subcommands: ['check', 'add', 'sync'],
    fix: 'x g resource <name>   # scaffolds a resource with its catalog keys',
  },
  {
    name: 'branch',
    summary: 'copy-on-write branch environments with a preview URL',
    usage: 'x branch [<name>|rm <name>] [--json]',
    fix: 'x db branch <name>   # the database half, shipped today',
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
    name: 'env',
    summary: 'validate the typed env; --fix writes the missing keys',
    usage: 'x env check [--fix] [--json]',
    subcommands: ['check'],
    fix: 'x doctor --json   # reports the env problems it can already see',
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
  {
    name: 'money',
    summary: 'extend the currency table',
    usage: 'x money add-currency <ISO> --exponent <n> [--json]',
    subcommands: ['add-currency'],
    fix: 'x manifest --json   # currencies ship in @ultimat3/money; add yours in app.config.ts',
  },
  {
    name: 'config',
    summary: 'the resolved app.config.ts, defaults included',
    usage: 'x config show [--json]',
    subcommands: ['show'],
    fix: 'x manifest --json   # the facts the resolved config produced',
  },
];

const specFor = (planned: PlannedCommand): CommandSpec => ({
  name: planned.name,
  summary: `${planned.summary} (planned)`,
  usage: planned.usage,
  ...(planned.subcommands === undefined ? {} : { subcommands: planned.subcommands }),
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
