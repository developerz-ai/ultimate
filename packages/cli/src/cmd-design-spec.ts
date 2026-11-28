// `x design`'s declaration, apart from its body: the parser, `x help` and the `errors` step read it
// without loading `cmd-design.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const DESIGN_SUBCOMMANDS = ['research'] as const;

export const designSpec: CommandSpec = {
  name: 'design',
  summary:
    'research a reference site: shots, measured palette/type/spacing/motion, a defineTheme() proposal and a motion map',
  usage:
    'x design research <url…> [--follow <n>] [--out .x/design] [--viewport 390x844,1440x900] [--allow-hosts <h,…>] [--timeout <ms>] [--json] · x design research --list',
  // No default: `research` drives a browser at the web, which is typed or not run.
  subcommands: [...DESIGN_SUBCOMMANDS],
  flags: [
    {
      name: 'follow',
      type: 'string',
      summary:
        'also research up to n links of each reference: same origin, or a --allow-hosts host',
    },
    {
      name: 'out',
      type: 'string',
      summary: 'where each reference directory is written (default .x/design, never committed)',
    },
    {
      name: 'viewport',
      type: 'string',
      summary:
        '<w>x<h>[,<w>x<h>] — the sizes each reference is photographed at (default 390x844,1440x900)',
    },
    {
      name: 'allow-hosts',
      type: 'string',
      summary:
        'extra public hosts --follow may visit; never widens what the browser may reach (private addresses stay refused)',
    },
    { name: 'timeout', type: 'string', summary: 'ms one reference navigation may take' },
    {
      name: 'list',
      type: 'boolean',
      summary: 'the default reference catalogues and the licence posture each is held to',
    },
  ],
};
