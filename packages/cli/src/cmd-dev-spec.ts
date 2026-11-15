// `x dev`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-dev.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';
import { DEV_ROLES } from './role-start-types';

export const devSpec: CommandSpec = {
  name: 'dev',
  summary: 'all roles in one process: embedded services, sub-second reload, /_x mounted',
  usage: 'x dev [--port 3000] [--host 0.0.0.0] [--tls] [--role web,worker] [--once] [--json]',
  requiresApp: true,
  flags: [
    // No `default`: a default reads exactly like a value the caller typed, and it outranked
    // `PORT` from the app's `.env.development` — `devPortFor` supplies the 3000 last.
    { name: 'port', type: 'string', summary: 'HTTP port (default: PORT, else 3000)' },
    // No `HOST` fallback, unlike the port: a container reads `HOST`, and an exported one in a
    // developer's shell must not quietly widen `x dev` past loopback.
    {
      name: 'host',
      type: 'string',
      summary:
        'interface to bind: an IP literal, 0.0.0.0 or :: (default: localhost; /_x stays loopback-only)',
    },
    {
      name: 'role',
      type: 'string',
      // `replicator` is named because it is selectable and NOT default — it takes a replication
      // slot on a shared database, which is not something every `x dev` should do by starting.
      summary: `roles to run (default: all of ${DEV_ROLES.join(',')}; replicator is opt-in)`,
    },
    {
      name: 'tls',
      type: 'boolean',
      summary:
        'serve https with a generated local certificate, cached in .x/tls/ (trust cert.pem once)',
    },
    { name: 'once', type: 'boolean', summary: 'boot, report, exit — for smoke tests and CI' },
  ],
};
