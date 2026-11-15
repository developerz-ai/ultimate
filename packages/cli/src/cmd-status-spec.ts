// `x status`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-status.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

/** `/readyz` reads per origin a bare `--url` takes: enough to see two builds behind one balancer. */
export const STATUS_DEFAULT_SAMPLES = 5;
/** The most per origin: each is its own connection, and this is a read, not a load test. */
export const STATUS_MAX_SAMPLES = 50;

export const statusSpec: CommandSpec = {
  name: 'status',
  summary:
    'what the running deployment is: the build each live worker runs, and what each --url answers',
  usage: 'x status [--url <origin>[,<origin>…]] [--samples n] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'url',
      type: 'string',
      summary:
        'origins whose /readyz to sample, comma-separated: the app, or a role’s health port (worker, scheduler, sync, replicator)',
    },
    {
      name: 'samples',
      type: 'string',
      summary: `/readyz reads per origin, each on its own connection, 1 to ${STATUS_MAX_SAMPLES} (default ${STATUS_DEFAULT_SAMPLES})`,
    },
  ],
};
