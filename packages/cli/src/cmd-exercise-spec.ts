// `x exercise`'s declaration, apart from its body: the parser, `x help` and the `errors` step
// read it without loading `cmd-exercise.ts`, which `registry.ts` imports only when the command runs.

import type { CommandSpec } from './parse';

export const exerciseSpec: CommandSpec = {
  name: 'exercise',
  summary: 'run every action, query and job once on generated rows, with no test written',
  usage: 'x exercise [<name>] [--seed n] [--json]',
  requiresApp: true,
  flags: [
    {
      name: 'seed',
      type: 'string',
      summary:
        'the integer the seed graph and every generated input are drawn from; same seed, same pass',
    },
  ],
};
