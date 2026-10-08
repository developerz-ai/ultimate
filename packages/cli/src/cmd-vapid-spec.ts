// `x vapid`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-vapid.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const VAPID_SUBCOMMANDS = ['show', 'create'] as const;

export const vapidSpec: CommandSpec = {
  name: 'vapid',
  summary: 'the Web Push key pair: show which one this app signs with, or create and seal one',
  usage: 'x vapid [show|create] [--json]',
  requiresApp: true,
  subcommands: [...VAPID_SUBCOMMANDS],
  // The bare form reads; `create` writes the committed secrets file, so it is never the default.
  defaultSubcommand: 'show',
  flags: [],
};
