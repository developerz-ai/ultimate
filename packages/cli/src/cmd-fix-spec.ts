// `x fix`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-fix.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const FIX_SUBCOMMANDS = ['boundary'] as const;

export const fixSpec: CommandSpec = {
  name: 'fix',
  // Says "plan" in the one line `x help` prints. The name is kept — five packages' `fix:` lines
  // cite `x fix boundary <file>` and renaming a shipped command breaks every one of them — so
  // the honest move is to stop the summary from promising a repair the command never performs.
  summary: 'plan the minimal cut for an import that crossed a surface boundary (never rewrites)',
  usage: 'x fix boundary <file> [--json]',
  requiresApp: true,
  subcommands: FIX_SUBCOMMANDS,
  defaultSubcommand: 'boundary',
};
