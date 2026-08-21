// The command registry: the one list the parser, the help catalogue and the dispatcher all read.
// A command that is not here does not exist — there is no second place to register one.

import { affectedCommand } from './cmd-affected';
import { buildCommand } from './cmd-build';
import { ciCommand } from './cmd-ci';
import { dbCommand } from './cmd-db';
import { deployCommand } from './cmd-deploy';
import { devCommand } from './cmd-dev';
import { docsCommand } from './cmd-docs';
import { doctorCommand } from './cmd-doctor';
import { envCommand } from './cmd-env';
import { errorsCommand } from './cmd-errors';
import { fixCommand } from './cmd-fix';
import { generateCommand } from './cmd-generate';
import { createHelpCommand, createVersionCommand } from './cmd-help';
import { i18nCommand } from './cmd-i18n';
import { jobsCommand } from './cmd-jobs';
import { manifestCommand } from './cmd-manifest';
import { mcpCommand } from './cmd-mcp';
import { newCommand } from './cmd-new';
import { plannedCommands } from './cmd-planned';
import { policyCommand } from './cmd-policy';
import { prCommand } from './cmd-pr';
import { actionsCommand, entitiesCommand, queriesCommand } from './cmd-registries';
import { routesCommand } from './cmd-routes';
import { secretsCommand } from './cmd-secrets';
import { shotCommand } from './cmd-shot';
import { tasksCommand } from './cmd-tasks';
import { testCommand } from './cmd-test';
import { verifyCommand } from './cmd-verify';
import type { CliCommand } from './command';
import type { CommandSpec } from './parse';
import { loadVersion } from './version-loader';

let cliVersionCache: string | undefined;

/**
 * Single source of truth for the CLI's own version — loaded from its package.json, lazily.
 * `index.ts` re-exports this module, so importing `@ultimat3/cli` for `runRole` alone — what a
 * compiled `apps/web/server.ts` does — must not read a manifest a `--compile` binary does not
 * carry. An eager `const` here reintroduced exactly the failure `frameworkVersion()` was made
 * lazy to fix, one file over: it compiled clean and threw at import on the first boot that
 * actually ran the artifact.
 */
export function cliVersion(): string {
  if (cliVersionCache === undefined) cliVersionCache = loadVersion();
  return cliVersionCache;
}

const CORE: readonly CliCommand[] = [
  newCommand,
  devCommand,
  buildCommand,
  testCommand,
  verifyCommand,
  generateCommand,
  dbCommand,
  mcpCommand,
  doctorCommand,
  deployCommand,
  envCommand,
  secretsCommand,
  manifestCommand,
  routesCommand,
  actionsCommand,
  queriesCommand,
  entitiesCommand,
  jobsCommand,
  tasksCommand,
  policyCommand,
  i18nCommand,
  errorsCommand,
  docsCommand,
  fixCommand,
  affectedCommand,
  shotCommand,
  prCommand,
  ciCommand,
];

/**
 * Planned last, so `x help` reads shipped-first and the tail is honestly labelled. They are in the
 * registry rather than absent from it because "not built yet" and "not a command" are different
 * facts, and only one of them is true — see `cmd-planned.ts`.
 */
export const COMMANDS: readonly CliCommand[] = [
  ...CORE,
  ...plannedCommands(),
  createHelpCommand(() => SPECS),
  createVersionCommand(cliVersion),
];

export const SPECS: readonly CommandSpec[] = COMMANDS.map((command) => command.spec);

export const commandFor = (name: string): CliCommand | undefined =>
  COMMANDS.find(
    (command) => command.spec.name === name || (command.spec.aliases ?? []).includes(name),
  );
