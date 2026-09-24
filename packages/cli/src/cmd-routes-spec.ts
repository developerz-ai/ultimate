// `x routes`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-routes.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const routesSpec: CommandSpec = {
  name: 'routes',
  summary: 'the route table: path, surface, render mode, hydrate, offline',
  usage: 'x routes [--surface site|app|api|shared] [--json]',
  requiresApp: true,
  flags: [{ name: 'surface', type: 'string', summary: 'filter by surface' }],
};
