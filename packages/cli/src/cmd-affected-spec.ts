// `x affected`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-affected.ts`, which `registry.ts` imports only when the command runs.

import { DEFAULT_BASE } from './affected';
import type { CommandSpec } from './parse';

export const affectedSpec: CommandSpec = {
  name: 'affected',
  summary: 'the workspaces a diff touches, and every workspace that depends on one of them',
  usage: 'x affected [--base <ref>] [--dirty] [--paths] [--json]',
  flags: [
    {
      name: 'base',
      type: 'string',
      summary: `git ref to diff against, merge-base style (default: ${DEFAULT_BASE})`,
    },
    {
      name: 'dirty',
      type: 'boolean',
      summary: 'also count uncommitted work — every agent sharing this checkout, not only yours',
    },
    { name: 'paths', type: 'boolean', summary: 'print bare directories instead of a table' },
  ],
};
