// `x repro`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-repro.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const reproSpec: CommandSpec = {
  name: 'repro',
  summary: 'a dead job or a captured 5xx, as a failing test: x repro <id> --write --verify',
  usage:
    'x repro <jobId|requestId|traceId|fingerprint> [--write] [--verify] | x repro --list [--code X_…] | x repro --from <file> [--write] [--verify] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'write',
      type: 'boolean',
      summary: 'write the test to repro/repro-<id>.<kind>.test.ts',
    },
    {
      name: 'verify',
      type: 'boolean',
      summary: 'run the written test and answer { reproduced, code, fingerprint }',
    },
    { name: 'list', type: 'boolean', summary: 'the captured bundles, newest first' },
    { name: 'code', type: 'string', summary: 'list: only bundles of this X_* code' },
    {
      name: 'from',
      type: 'string',
      summary: 'a bundle file (x repro <id> --json) instead of the database',
    },
  ],
};
