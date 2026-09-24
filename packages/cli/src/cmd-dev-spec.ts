// `x dev`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-dev.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';
import { DEV_ROLES } from './role-start-types';

export const devSpec: CommandSpec = {
  name: 'dev',
  summary: 'all roles in one process: embedded services, sub-second reload, /_x mounted',
  usage: 'x dev [--port 3000] [--role web,worker] [--once] [--json]',
  requiresApp: true,
  flags: [
    // No `default`: a default reads exactly like a value the caller typed, and it outranked
    // `PORT` from the app's `.env.development` — `devPortFor` supplies the 3000 last.
    { name: 'port', type: 'string', summary: 'HTTP port (default: PORT, else 3000)' },
    {
      name: 'role',
      type: 'string',
      // `replicator` is named because it is selectable and NOT default — it takes a replication
      // slot on a shared database, which is not something every `x dev` should do by starting.
      summary: `roles to run (default: all of ${DEV_ROLES.join(',')}; replicator is opt-in)`,
    },
    { name: 'once', type: 'boolean', summary: 'boot, report, exit — for smoke tests and CI' },
  ],
};
