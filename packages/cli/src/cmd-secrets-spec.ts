// `x secrets`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-secrets.ts`, which `registry.ts` imports only when the command runs.

import { ENV_SCHEMA_EXPORT } from './app-env';
import type { CommandSpec } from './parse';

export const SECRETS_SUBCOMMANDS = ['show', 'init', 'edit', 'set', 'rotate'] as const;

export const secretsSpec: CommandSpec = {
  name: 'secrets',
  summary: `the committed encrypted secrets, decrypted into the ${ENV_SCHEMA_EXPORT} variables of the same names`,
  usage: 'x secrets [show|init|edit|set <NAME>|rotate] [--json]',
  requiresApp: true,
  subcommands: [...SECRETS_SUBCOMMANDS],
  // The bare `x secrets` answers without a key ever leaving the file. Declared, not inherited
  // from the array's order — `init`, `edit`, `set` and `rotate` all write.
  defaultSubcommand: 'show',
  flags: [],
};
