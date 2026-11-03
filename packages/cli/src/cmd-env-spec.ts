// `x env`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-env.ts`, which `registry.ts` imports only when the command runs.

import { APP_CONFIG_FILE } from '@ultimat3/core';
import { ENV_SCHEMA_EXPORT } from './app-env';
import type { CommandSpec } from './parse';

export const envSpec: CommandSpec = {
  name: 'env',
  summary: `the typed environment declared by ${ENV_SCHEMA_EXPORT} in ${APP_CONFIG_FILE}`,
  usage: 'x env [check|example] [--json] | x env init --production [--json]',
  requiresApp: true,
  subcommands: ['check', 'example', 'init'],
  // The bare `x env` answers the question the fix line on every `X_ENV_MISSING` in this
  // framework already tells its reader to run.
  defaultSubcommand: 'check',
  flags: [
    {
      name: 'production',
      type: 'boolean',
      summary: 'write .env.production: what x deploy --method compose reads, secrets generated',
      subcommands: ['init'],
    },
  ],
};
