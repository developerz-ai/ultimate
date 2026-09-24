// `x verify`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-verify.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';
import { WORKER_CEILING, WORKER_FLOOR, WORKER_OVERSUBSCRIBE } from './test-workers';

export const verifySpec: CommandSpec = {
  name: 'verify',
  summary: 'the gate: typecheck, lint, boundaries, all tests, drift, contract, budgets',
  usage: 'x verify [--only <step>] [--workers N] [--json]',
  requiresApp: true,
  // Two flags, and only one of them narrows. `--workers` changes how wide the test steps
  // spread, never which steps run. `--only` runs one step and says so in both renderers —
  // never silently, which is the whole of what makes it safe to have.
  flags: [
    {
      name: 'workers',
      type: 'string',
      summary: `test processes per parallel step (default: ${WORKER_OVERSUBSCRIBE}x CPUs, min ${WORKER_FLOOR}, max ${WORKER_CEILING})`,
    },
    {
      name: 'only',
      type: 'string',
      summary:
        'run ONE step by name — an iteration loop, NOT A GATE RUN; the gate is this command with no flag',
    },
  ],
};
