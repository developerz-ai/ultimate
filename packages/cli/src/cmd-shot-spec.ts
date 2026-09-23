// `x shot`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-shot.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const shotSpec: CommandSpec = {
  name: 'shot',
  summary: 'photograph one route, one island in a state it declares, or every island in the app',
  usage:
    'x shot <route> | --island <name> [--state <id>] | --all-islands [--port 0] [--out <dir>] [--settle 2000] [--json]',
  requiresApp: true,
  flags: [
    { name: 'port', type: 'string', summary: 'dev port (0 lets the kernel pick a free one)' },
    { name: 'out', type: 'string', summary: 'where shot.png and verdict.json are written' },
    { name: 'full', type: 'boolean', summary: 'whole page, not the fold', default: true },
    { name: 'settle', type: 'string', summary: 'ms to wait after load before capturing' },
    { name: 'timeout', type: 'string', summary: 'ms one navigation may take' },
    { name: 'browser', type: 'string', summary: 'Chrome or Chromium binary to launch' },
    {
      name: 'cdp-url',
      type: 'string',
      summary: 'attach to a browser somebody else is running (a provider session, a sidecar)',
    },
    { name: 'allow-hosts', type: 'string', summary: 'extra hosts the page may request' },
    {
      name: 'theme',
      type: 'string',
      summary: "light or dark, stored as the visitor's choice; absent is the app's own default",
    },
    // A FLAG on `x shot` and never a second command: photographing a route and photographing a
    // component are one job with two subjects, and a parallel command would be the second path
    // axiom 1 refuses.
    {
      name: 'island',
      type: 'string',
      summary: 'photograph one island in every state it declares',
    },
    {
      name: 'state',
      type: 'string',
      summary: 'one declared state of that island, not all of them',
    },
    // Its own SPELLING and never `--island` with no value: the parser refuses a bare `--island`
    // ("expects a value") and `--island=` is an empty name, so "every island" had no form a
    // reader could type that could not be read as a mistyped one. A boolean cannot be confused
    // with a name, and `x shot --all-islands` says what it does beside `x shot --island <name>`.
    {
      name: 'all-islands',
      type: 'boolean',
      summary: 'every island in the app, in every state it declares, plus an index.md',
    },
  ],
};
