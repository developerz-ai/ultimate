// `x secrets`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-secrets.ts`, which `registry.ts` imports only when the command runs.

import { ENV_SCHEMA_EXPORT } from './app-env';
import type { CommandSpec } from './parse';

export const SECRETS_SUBCOMMANDS = ['show', 'init', 'edit', 'set', 'rotate'] as const;

export const secretsSpec: CommandSpec = {
  name: 'secrets',
  // The key is read from the env and the file only, and the summary says so: importing
  // `apps/<app>/runtime.ts` for its `secretSource` would run the app's boot guards, which may need
  // the very secrets this command edits. A KMS/Vault source is the booted app's (`runtime.ts`).
  summary: `the committed encrypted secrets, decrypted into the ${ENV_SCHEMA_EXPORT} variables of the same names; the master key is ULTIMATE_SECRETS_KEY or .secrets.key only — a runtime.ts secretSource is the booted app's`,
  usage: 'x secrets [show|init|edit|set <NAME>|rotate [--drop <keyId>]] [--json]',
  requiresApp: true,
  subcommands: [...SECRETS_SUBCOMMANDS],
  // The bare `x secrets` answers without a key ever leaving the file. Declared, not inherited
  // from the array's order — `init`, `edit`, `set` and `rotate` all write.
  defaultSubcommand: 'show',
  flags: [
    {
      name: 'drop',
      type: 'string',
      summary:
        'rotate: remove one retired master key by id once every value sealed under it is re-sealed; generates no new key',
      subcommands: ['rotate'],
    },
  ],
};
