// `x i18n`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-i18n.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const I18N_SUBCOMMANDS = ['check', 'add', 'sync'] as const;

export const i18nSpec: CommandSpec = {
  name: 'i18n',
  summary: 'catalogs: add a locale, sync keys, check for gaps',
  usage: 'x i18n [check|add <locale>|sync <locale>] [--json]',
  requiresApp: true,
  subcommands: I18N_SUBCOMMANDS,
  // The bare `x i18n` audits; `add` and `sync` write catalogs and must be asked for.
  defaultSubcommand: 'check',
};
