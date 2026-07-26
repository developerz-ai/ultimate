// The command registry: the one list the parser, the help catalogue and the dispatcher all read.
// A command that is not here does not exist — there is no second place to register one.

import { buildCommand } from './cmd-build';
import { dbCommand } from './cmd-db';
import { deployCommand } from './cmd-deploy';
import { devCommand } from './cmd-dev';
import { doctorCommand } from './cmd-doctor';
import { generateCommand } from './cmd-generate';
import { createHelpCommand, createVersionCommand } from './cmd-help';
import { manifestCommand } from './cmd-manifest';
import { mcpCommand } from './cmd-mcp';
import { newCommand } from './cmd-new';
import { routesCommand } from './cmd-routes';
import { testCommand } from './cmd-test';
import { verifyCommand } from './cmd-verify';
import type { CliCommand } from './command';
import type { CommandSpec } from './parse';

export const CLI_VERSION = '0.0.1';

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
  manifestCommand,
  routesCommand,
];

export const COMMANDS: readonly CliCommand[] = [
  ...CORE,
  createHelpCommand(() => SPECS),
  createVersionCommand(CLI_VERSION),
];

export const SPECS: readonly CommandSpec[] = COMMANDS.map((command) => command.spec);

export const commandFor = (name: string): CliCommand | undefined =>
  COMMANDS.find(
    (command) => command.spec.name === name || (command.spec.aliases ?? []).includes(name),
  );
