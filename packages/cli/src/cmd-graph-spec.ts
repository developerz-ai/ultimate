// `x graph`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-graph.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const graphSpec: CommandSpec = {
  name: 'graph',
  summary:
    'the app as one typed graph: routes, primitives, tags, MCP tools, files and tests, each edge with its provenance',
  usage: 'x graph [--from <node> --to <node>] [--json]',
  requiresApp: true,
  flags: [
    { name: 'from', type: 'string', summary: 'a node id, primitive name or file path to start at' },
    { name: 'to', type: 'string', summary: 'the node to explain a link to; needs --from' },
  ],
};
