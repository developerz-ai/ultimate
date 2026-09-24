// `x doctor`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-doctor.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** The port `x dev` binds by default, so the probe answers about the port the developer will use. */
export const DEFAULT_DOCTOR_PORT = 3000;

export const doctorSpec: CommandSpec = {
  name: 'doctor',
  summary: 'environment, versions, drift, ports, PWA prerequisites — each with a fix command',
  usage: 'x doctor [--port 3000] [--json]',
  flags: [
    {
      name: 'port',
      type: 'string',
      summary: 'port to test',
      default: String(DEFAULT_DOCTOR_PORT),
    },
  ],
};
