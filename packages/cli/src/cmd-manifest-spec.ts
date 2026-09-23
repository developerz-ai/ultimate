// `x manifest`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-manifest.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const manifestSpec: CommandSpec = {
  name: 'manifest',
  summary: 'regenerate x.manifest.json and openapi.json from the code',
  usage: 'x manifest [--check] [--json]',
  requiresApp: true,
  flags: [
    { name: 'check', type: 'boolean', summary: 'fail if the committed files are stale' },
    { name: 'openapi', type: 'boolean', summary: 'also write openapi.json', default: true },
  ],
};
