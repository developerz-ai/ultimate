// `x i18n`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-i18n.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const I18N_SUBCOMMANDS = ['check', 'add', 'sync', 'split'] as const;

export const i18nSpec: CommandSpec = {
  name: 'i18n',
  summary: 'catalogs: add a locale, sync keys, check for gaps, split into namespace files',
  usage: 'x i18n [check|add <locale>|sync <locale>|split [<locale>]] [--json]',
  requiresApp: true,
  subcommands: I18N_SUBCOMMANDS,
  // The bare `x i18n` audits; `add`, `sync` and `split` write catalogs and must be asked for.
  defaultSubcommand: 'check',
};
