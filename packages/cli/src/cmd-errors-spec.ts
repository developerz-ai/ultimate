// `x errors`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-errors.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const ERRORS_SUBCOMMANDS = ['explain', 'list'] as const;

export const errorsSpec: CommandSpec = {
  name: 'errors',
  summary: 'an X_* code, explained: cause, runnable fix, docs URL',
  usage: 'x errors [explain <CODE>|list] [--json]',
  subcommands: ERRORS_SUBCOMMANDS,
  // `explain`, deliberately: the bare `x errors` then answers with `MissingPositionalError`,
  // which names `<CODE>` and hands back a real invocation. `list` would silently print 200 rows
  // to a caller who meant to explain one — see `MissingPositionalError`'s own note.
  defaultSubcommand: 'explain',
  // `x errors X_PERMISSION_UNKNOWN` is the form every reader tries first — `x help` prints
  // `errors  an X_* code, explained`, which reads as exactly that — and it answered
  // `X_CLI_UNKNOWN_COMMAND … fix: x help`, which leads back to the line that suggested it.
  // Safe to declare here and nowhere else so far: the only thing that is not `explain` or
  // `list` in this slot is a code, and a near miss of either is still refused (#F16).
  defaultSubcommandTakesPositional: true,
};
