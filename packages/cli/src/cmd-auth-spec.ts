// `x auth`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-auth.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const AUTH_SUBCOMMANDS = ['seal-mfa'] as const;

export const authSpec: CommandSpec = {
  name: 'auth',
  summary: 'one-shot maintenance of the auth tables: seal every plaintext second-factor secret',
  usage: 'x auth seal-mfa [--json]',
  requiresApp: true,
  // No default: the one subcommand WRITES, and a bare `x auth` must not.
  subcommands: [...AUTH_SUBCOMMANDS],
  flags: [],
};
