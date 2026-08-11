// The command registry: the one list the parser, the help catalogue and the dispatcher all read.
// A command that is not here does not exist — there is no second place to register one.

import { buildCommand } from './cmd-build';
import { dbCommand } from './cmd-db';
import { deployCommand } from './cmd-deploy';
import { devCommand } from './cmd-dev';
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
import { actionsCommand, entitiesCommand, queriesCommand } from './cmd-registries';
import { routesCommand } from './cmd-routes';
import { tasksCommand } from './cmd-tasks';
import { testCommand } from './cmd-test';
import { verifyCommand } from './cmd-verify';
import type { CliCommand } from './command';
import type { CommandSpec } from './parse';
import { loadVersion } from './version-loader';

/** Single source of truth for the framework version — loaded from root package.json. */
export const CLI_VERSION = loadVersion();

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
  fixCommand,
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
  createVersionCommand(CLI_VERSION),
];

export const SPECS: readonly CommandSpec[] = COMMANDS.map((command) => command.spec);

export const commandFor = (name: string): CliCommand | undefined =>
  COMMANDS.find(
    (command) => command.spec.name === name || (command.spec.aliases ?? []).includes(name),
  );
