// `x mail`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-mail.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const MAIL_SUBCOMMANDS = ['preview'] as const;

export const mailSpec: CommandSpec = {
  name: 'mail',
  summary: "render a mail's declared preview in every locale, nothing sent",
  usage: 'x mail preview <id> [--locale <tag>] [--tz <zone>] [--out <dir>] [--json]',
  requiresApp: true,
  subcommands: MAIL_SUBCOMMANDS,
  defaultSubcommand: 'preview',
  flags: [
    { name: 'locale', type: 'string', summary: 'one locale; default every locale the app routes' },
    {
      name: 'tz',
      type: 'string',
      summary: 'IANA zone every date in the body renders in; default UTC, as the /_x panel',
    },
    {
      name: 'out',
      type: 'string',
      summary: 'write <id>.<locale>.html and .txt into this directory',
    },
  ],
};
