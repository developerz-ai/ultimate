// `x doctor`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-doctor.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const doctorSpec: CommandSpec = {
  name: 'doctor',
  summary: 'environment, versions, drift, ports, PWA prerequisites — each with a fix command',
  usage: 'x doctor [--port 3000] [--json]',
  flags: [
    // No `default`: it would be indistinguishable from a typed value, and `PORT` could never win.
    { name: 'port', type: 'string', summary: 'port to test (default: PORT, then 3000)' },
  ],
};
