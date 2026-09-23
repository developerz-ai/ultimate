// `x env`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-env.ts`, which `registry.ts` imports only when the command runs.

import { ENV_SCHEMA_EXPORT } from './app-env';
import { APP_CONFIG_FILE } from './app-root';
import type { CommandSpec } from './parse';

export const envSpec: CommandSpec = {
  name: 'env',
  summary: `the typed environment declared by ${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE}`,
  usage: 'x env [check|example] [--json]',
  requiresApp: true,
  subcommands: ['check', 'example'],
  // The bare `x env` answers the question the fix line on every `X_ENV_MISSING` in this
  // framework already tells its reader to run.
  defaultSubcommand: 'check',
  flags: [],
};
