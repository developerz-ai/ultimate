// `x generate`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-generate.ts`, which `registry.ts` imports only when the command runs.

import { GENERATORS } from './generate-kinds';
import type { CommandSpec } from './parse';

export const generateSpec: CommandSpec = {
  name: 'g',
  aliases: ['generate'],
  summary: 'scaffold a primitive with its passing test',
  // Projected from `GENERATORS`, never restated: the literal that used to live here had already
  // drifted — it omitted `backfill` — and a usage line that can disagree with the list it
  // describes is exactly the second source of truth axiom 2 forbids.
  usage: `x g ${GENERATORS.join('|')} <name> [--feature f]`,
  // Declared from the SAME constant `readKind` validates against: without it `fix-command.ts`
  // has no set to judge the word after `x g`, and two shipped `@ultimat3/admin` fix lines said
  // `x g migration` — a generator that has never existed — straight through the `errors` gate.
  positionalChoices: GENERATORS,
  requiresApp: true,
  flags: [
    { name: 'feature', type: 'string', summary: 'feature slice to write into' },
    { name: 'surface', type: 'string', summary: 'site | app', default: 'app' },
    { name: 'live', type: 'boolean', summary: 'subscribable query' },
    { name: 'admin', type: 'boolean', summary: 'resource: also emit the admin override' },
    { name: 'locales', type: 'string', summary: 'comma-separated locales, default en' },
    { name: 'at', type: 'string', summary: 'island, admin:page: directory to write into' },
    { name: 'permission', type: 'string', summary: 'admin:page: the permission it needs' },
    { name: 'force', type: 'boolean', summary: 'overwrite existing files' },
    { name: 'dry-run', type: 'boolean', summary: 'print the file list, write nothing' },
  ],
};
