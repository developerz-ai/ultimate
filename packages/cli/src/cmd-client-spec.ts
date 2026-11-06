// `x client`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-client.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const CLIENT_SUBCOMMANDS = ['vendor', 'customer'] as const;

export const clientSpec: CommandSpec = {
  name: 'client',
  summary:
    'a typed client compiled from an OpenAPI document: a vendor you call, or the one your customers call you with',
  usage:
    'x client vendor <name> [--from <file|url>] [--only <tag,…>] [--json] · x client customer --out <dir> [--mount <prefix>] [--only <tag,…>] [--package <name>] [--json]',
  requiresApp: true,
  subcommands: [...CLIENT_SUBCOMMANDS],
  // Both write files, into two different places: neither is a default a bare `x client` may pick.
  flags: [
    {
      name: 'from',
      type: 'string',
      summary: "the document, a file or an https URL; omitted, the client's committed source.json",
      subcommands: ['vendor'],
    },
    {
      name: 'only',
      type: 'string',
      summary: 'keep only operations carrying one of these comma-separated tags',
    },
    {
      name: 'out',
      type: 'string',
      summary: 'the directory the client is written to',
      subcommands: ['customer'],
    },
    {
      name: 'mount',
      type: 'string',
      summary: "a bearer mount's prefix — its own document, not the app's",
      subcommands: ['customer'],
    },
    {
      name: 'package',
      type: 'string',
      summary: 'also write a package.json with this name, ready to publish',
      subcommands: ['customer'],
    },
  ],
};
